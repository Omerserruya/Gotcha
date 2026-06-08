/**
 * System Copilot — agent runtime.
 *
 * The conversational loop powering the Command Center. On each `run()` call:
 *   1. Load short-term memory + UI context.
 *   2. Compose the chat-message list (system prompt + context + history + current turn).
 *   3. Stream the LLM response via `streamResponse()`. Forward content tokens
 *      to the consumer via the `onEvent` callback.
 *   4. If the model emits tool_calls, dispatch each through
 *      `dispatchSystemToolCall` (system_*, propose_plan, integration_*, etc.),
 *      append the tool result, and loop.
 *   5. Stop when the model returns a final assistant turn with no tool calls,
 *      or when MAX_ROUNDS is hit.
 *
 * The runtime is transport-agnostic: callers pass an `onEvent(SSEEvent)`
 * sink. The `/api/agent/run` route wraps this with an SSE writer; tests
 * collect events into an array.
 */

import fs from "fs";
import path from "path";
import { streamResponse } from "./ai.service";
import {
  appendToMemory,
  getAgentMemory,
  memoryToChatMessages,
  sanitizeHistoryForLLM,
} from "./agent-memory.service";
import { buildAgentContext } from "./agent-context.service";
import type { ClientContext, OperatorContext } from "./agent-context.service";
import {
  buildSystemAgentTools,
  dispatchSystemToolCall,
} from "./system-tools.service";

const MAX_ROUNDS = 5;
const PROMPTS_DIR = path.resolve(__dirname, "../prompts");
const SYSTEM_PROMPT = fs.readFileSync(path.join(PROMPTS_DIR, "system-copilot.md"), "utf-8").trim();

// ─── Event surface (transport-agnostic) ─────────────────────

export type AgentRuntimeEvent =
  | { type: "ready"; sessionId: string }
  | { type: "context_attached"; resolved: { conversationId: string | null; contactId: string | null; route: string | null } }
  | { type: "token"; text: string }
  | { type: "tool_start"; toolCallId: string; name: string; args: unknown }
  | { type: "tool_end"; toolCallId: string; name: string; ok: boolean; resultSummary: string }
  | { type: "plan_proposed"; approvalRequestId: string; summary: string }
  | { type: "awaiting_approval"; approvalRequestId: string; tool: string }
  | { type: "denied"; tool: string; reason: string }
  | { type: "round_end"; round: number; hadToolCalls: boolean }
  | { type: "done"; usage: { input_tokens: number; output_tokens: number; total_tokens: number }; rounds: number }
  | { type: "error"; message: string };

export interface AgentRunInput {
  operator: OperatorContext;
  client?: ClientContext | null;
  message: string;
  /** Stable session id from the client (one per modal-open). Used to group
   *  memory rows and (later) enable summarisation per session. */
  sessionId: string;
  /** Optional override (e.g., gpt-4o for reasoning-heavy turns). Defaults
   *  to the central service's default model. */
  model?: string;
  /** When true, skip persisting this turn to memory (useful for
   *  ephemeral previews). Default false. */
  ephemeral?: boolean;
  /** Optional AIAgent ID to scope the integration-tool surface to a
   *  specific agent's grants. Omit to expose every enabled tenant tool. */
  aiAgentId?: string | null;
  /** Bearer token for downstream service calls dispatched by tool runs. */
  authToken?: string;
}

export type AgentEventSink = (event: AgentRuntimeEvent) => void | Promise<void>;

// ─── The loop ───────────────────────────────────────────────

export async function runAgent(
  input: AgentRunInput,
  onEvent: AgentEventSink,
): Promise<void> {
  await onEvent({ type: "ready", sessionId: input.sessionId });

  // 1. UI context — resolved IDs travel with the tool dispatcher so calls
  //    like `system_summarize_conversation` can default to the selected
  //    conversation without an explicit arg.
  const ctxBuilt = await buildAgentContext({ operator: input.operator, client: input.client ?? null });
  await onEvent({ type: "context_attached", resolved: ctxBuilt.resolved });

  // 2. Memory + new user turn.
  const history = await getAgentMemory({
    tenantId: input.operator.tenantId,
    userId: input.operator.userId,
  });

  const chatMessages: any[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: ctxBuilt.block },
    ...sanitizeHistoryForLLM(memoryToChatMessages(history)),
    { role: "user", content: input.message },
  ];

  if (!input.ephemeral) {
    await appendToMemory({
      tenantId: input.operator.tenantId,
      userId: input.operator.userId,
      sessionId: input.sessionId,
      role: "user",
      content: input.message,
    });
  }

  // 3. Tool surface for the operator.
  const tools = await buildSystemAgentTools({
    tenantId: input.operator.tenantId,
    aiAgentId: input.aiAgentId ?? null,
  });

  let totalUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  let round = 0;
  let stopReason: "final" | "max_rounds" | "error" = "final";

  for (round = 0; round < MAX_ROUNDS; round++) {
    let finalContent = "";
    let finalToolCalls: any[] | undefined;

    try {
      for await (const ev of streamResponse({
        tenantId: input.operator.tenantId,
        model: input.model,
        messages: chatMessages,
        temperature: 0.4,
        maxTokens: 1024,
        tools,
        metadata: { type: "system_copilot", aiAgentId: input.aiAgentId ?? undefined },
      })) {
        if (ev.contentDelta) await onEvent({ type: "token", text: ev.contentDelta });
        if (ev.done) {
          finalContent = ev.content || "";
          finalToolCalls = ev.toolCalls;
          if (ev.usage) {
            totalUsage = {
              input_tokens: totalUsage.input_tokens + ev.usage.input_tokens,
              output_tokens: totalUsage.output_tokens + ev.usage.output_tokens,
              total_tokens: totalUsage.total_tokens + ev.usage.total_tokens,
            };
          }
        }
      }
    } catch (err: any) {
      stopReason = "error";
      await onEvent({ type: "error", message: err?.message || "stream failed" });
      break;
    }

    if (!finalToolCalls || finalToolCalls.length === 0) {
      // Model is done — final answer turn.
      if (finalContent && !input.ephemeral) {
        await appendToMemory({
          tenantId: input.operator.tenantId,
          userId: input.operator.userId,
          sessionId: input.sessionId,
          role: "assistant",
          content: finalContent,
        });
      }
      await onEvent({ type: "round_end", round, hadToolCalls: false });
      stopReason = "final";
      break;
    }

    // Model wants tool calls. Append the assistant turn (with tool_calls)
    // to chatMessages so the protocol stays valid, then dispatch each
    // tool, append its result, and loop.
    chatMessages.push({
      role: "assistant",
      content: finalContent || "",
      tool_calls: finalToolCalls,
    });
    if (!input.ephemeral) {
      await appendToMemory({
        tenantId: input.operator.tenantId,
        userId: input.operator.userId,
        sessionId: input.sessionId,
        role: "assistant",
        content: finalContent || "",
        toolCalls: finalToolCalls,
      });
    }

    let pausedForApproval: { approvalRequestId: string; tool: string } | null = null;

    for (const tc of finalToolCalls) {
      let parsedArgs: unknown = {};
      try { parsedArgs = JSON.parse(tc.function?.arguments || "{}"); } catch { /* keep raw */ }
      await onEvent({
        type: "tool_start",
        toolCallId: tc.id,
        name: tc.function?.name || "unknown",
        args: parsedArgs,
      });

      const r = await dispatchSystemToolCall(tc, {
        tenantId: input.operator.tenantId,
        userId: input.operator.userId,
        selectedConversationId: ctxBuilt.resolved.conversationId,
        selectedContactId: ctxBuilt.resolved.contactId,
        authToken: input.authToken,
      });

      // Surface side-effects to the consumer for UI cues (toast, badge, etc).
      if (r.sideEffect?.kind === "proposed_plan") {
        await onEvent({
          type: "plan_proposed",
          approvalRequestId: r.sideEffect.approvalRequestId,
          summary: r.sideEffect.planSummary,
        });
      } else if (r.sideEffect?.kind === "awaiting_approval") {
        await onEvent({
          type: "awaiting_approval",
          approvalRequestId: r.sideEffect.approvalRequestId,
          tool: r.sideEffect.tool,
        });
        pausedForApproval = {
          approvalRequestId: r.sideEffect.approvalRequestId,
          tool: r.sideEffect.tool,
        };
      } else if (r.sideEffect?.kind === "denied") {
        await onEvent({ type: "denied", tool: r.sideEffect.tool, reason: r.sideEffect.reason });
      }

      const ok = !/\"ok\":\s*false/.test(r.content);
      await onEvent({
        type: "tool_end",
        toolCallId: tc.id,
        name: tc.function?.name || "unknown",
        ok,
        resultSummary: summariseToolResult(r.content),
      });

      chatMessages.push({
        role: "tool",
        tool_call_id: r.toolCallId,
        content: r.content,
      });
      if (!input.ephemeral) {
        await appendToMemory({
          tenantId: input.operator.tenantId,
          userId: input.operator.userId,
          sessionId: input.sessionId,
          role: "tool",
          content: r.content,
          toolCallId: r.toolCallId,
          toolName: tc.function?.name || undefined,
        });
      }
    }

    await onEvent({ type: "round_end", round, hadToolCalls: true });

    if (pausedForApproval) {
      // A gated tool produced an approval. The model gets ONE more turn to
      // tell the operator what happened (in their language); after that we
      // stop so we don't keep proposing the same action.
      // Pass-through to the next round; the prompt + tool result will guide it.
    }
  }

  if (round >= MAX_ROUNDS) stopReason = "max_rounds";

  await onEvent({ type: "done", usage: totalUsage, rounds: round });

  // Best-effort: if the loop terminated with `error`, log; the caller
  // already received the error event.
  if (stopReason === "error") {
    console.warn("[agent-runtime] run terminated with error after", round, "rounds");
  }
}

function summariseToolResult(jsonStr: string): string {
  // Compress noisy JSON down to a single line for the SSE event consumer.
  try {
    const parsed = JSON.parse(jsonStr);
    if (parsed?.ok === false) return `error: ${String(parsed.error || "unknown").slice(0, 120)}`;
    if (Array.isArray(parsed?.results)) return `results: ${parsed.results.length}`;
    if (typeof parsed?.count === "number") return `count: ${parsed.count}`;
    if (typeof parsed?.value === "number") return `value: ${parsed.value}`;
    if (parsed?.proposed_plan) return `plan_proposed`;
    if (parsed?.awaiting_approval) return `awaiting_approval`;
    return "ok";
  } catch {
    return jsonStr.slice(0, 120);
  }
}
