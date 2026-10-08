/**
 * System Copilot - agent runtime.
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
  getSessionMemory,
  memoryToChatMessages,
  sanitizeHistoryForLLM,
} from "./agent-memory.service";
import { withoutWideDashes } from "../lib/wide-dash";
import { buildAgentContext } from "./agent-context.service";
import type { ClientContext, OperatorContext } from "./agent-context.service";
import {
  buildSystemAgentTools,
  dispatchSystemToolCall,
  stepText,
} from "./system-tools.service";
import { connectedStore } from "./assistant-commerce-query.service";

const MAX_ROUNDS = 5;
const PROMPTS_DIR = path.resolve(__dirname, "../prompts");
const SYSTEM_PROMPT = fs.readFileSync(path.join(PROMPTS_DIR, "system-copilot.md"), "utf-8").trim();

// ─── Event surface (transport-agnostic) ─────────────────────

export type AgentRuntimeEvent =
  | { type: "ready"; sessionId: string }
  | { type: "context_attached"; resolved: { conversationId: string | null; contactId: string | null; route: string | null } }
  | { type: "token"; text: string }
  | { type: "tool_start"; toolCallId: string; name: string; args: unknown; label: string }
  | { type: "tool_end"; toolCallId: string; name: string; ok: boolean; resultSummary: string; label: string }
  | { type: "plan_proposed"; approvalRequestId: string; summary: string }
  | { type: "awaiting_approval"; approvalRequestId: string; tool: string }
  | { type: "denied"; tool: string; reason: string }
  | { type: "round_end"; round: number; hadToolCalls: boolean }
  | { type: "done"; usage: { input_tokens: number; output_tokens: number; total_tokens: number }; rounds: number }
  | { type: "cancelled" }
  /** Stage 2: cards and their source, computed by a query tool (shown as they are). */
  | { type: "artifacts"; toolCallId: string; blocks: unknown[]; source: unknown }
  | { type: "error"; message: string; code?: "BUDGET_EXCEEDED" | "AI_UNAVAILABLE" };

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
  /** Aborting stops the model call in flight and every round/tool after it. */
  signal?: AbortSignal;
  /** Tokens all model calls of this run may use together; reaching it ends the run. */
  tokenBudget?: number;
  /** Extra system lines for this run (a thread's scope, its answer format). */
  extraSystem?: string[];
  /** The period query tools default to (a thread's scope as workspace days). */
  defaultPeriod?: { from: string; to: string };
  /** Told the names of the tools this run may call (a Home thread keeps only suggestions one of them can answer). */
  onTools?: (names: string[]) => void;
}

export type AgentEventSink = (event: AgentRuntimeEvent) => void | Promise<void>;

// ─── The loop ───────────────────────────────────────────────

export async function runAgent(
  input: AgentRunInput,
  sink: AgentEventSink,
): Promise<void> {
  // Everything the operator sees passes here: no wide dash in any event
  // (Omer's rule; the model writes them anyway). A dash is one character, so
  // a per-delta replace never splits one.
  const onEvent: AgentEventSink = (ev) => sink(withoutWideDashes(ev));
  await onEvent({ type: "ready", sessionId: input.sessionId });

  // 1. UI context - resolved IDs travel with the tool dispatcher so calls
  //    like `system_summarize_conversation` can default to the selected
  //    conversation without an explicit arg.
  const ctxBuilt = await buildAgentContext({ operator: input.operator, client: input.client ?? null });
  await onEvent({ type: "context_attached", resolved: ctxBuilt.resolved });

  // 2. Memory + new user turn.
  // Memory is per session (a Cmd-K opening, a Home chat thread), never the
  // user's whole history: the global window mixed unrelated sessions, and the
  // AI-Employee Builder's interview turns (same table) leaked into it.
  const history = await getSessionMemory({
    tenantId: input.operator.tenantId,
    userId: input.operator.userId,
    sessionId: input.sessionId,
    limit: 30,
  });

  const chatMessages: any[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: ctxBuilt.block },
    ...(input.extraSystem ?? []).map((content) => ({ role: "system", content })),
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
  // Store tools only for a caller who may read orders, and only with a store.
  const commerce = !!input.operator.canReadCommerce && !!(await connectedStore(input.operator.tenantId).catch(() => null));
  const tools = await buildSystemAgentTools({
    tenantId: input.operator.tenantId,
    aiAgentId: input.aiAgentId ?? null,
    commerce,
    knowledge: !!input.operator.canReadKnowledge,
  });
  input.onTools?.(tools.map((t: any) => String(t?.function?.name ?? "")).filter(Boolean));

  let totalUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  let round = 0;
  let stopReason: "final" | "max_rounds" | "error" | "cancelled" | "budget" = "final";
  const aborted = () => !!input.signal?.aborted;
  // One id space per answer: "b1", "s1"... across every query tool call.
  const seq = { b: 0, s: 0 };
  const nextId = (k: "b" | "s") => `${k}${++seq[k]}`;
  // One answer reads each thing once. The model asks the same query twice in
  // a turn, and the user got two identical cards and two sources
  // (Omer, 2026-10-08): a repeat gets the first result, with no new step,
  // card or source. Reads only (system_*); an action is never skipped here.
  const answered = new Map<string, string>(); // a read call → its result
  const drawn = new Map<string, string>(); // a source's query → the result that drew it

  for (round = 0; round < MAX_ROUNDS; round++) {
    if (aborted()) { stopReason = "cancelled"; break; }
    if (input.tokenBudget && totalUsage.total_tokens >= input.tokenBudget) { stopReason = "budget"; break; }
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
        signal: input.signal,
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
      if (aborted()) { stopReason = "cancelled"; break; }
      stopReason = "error";
      await onEvent({ type: "error", message: err?.message || "stream failed", code: "AI_UNAVAILABLE" });
      break;
    }

    if (!finalToolCalls || finalToolCalls.length === 0) {
      // Model is done - final answer turn.
      if (finalContent && !input.ephemeral) {
        await appendToMemory({
          tenantId: input.operator.tenantId,
          userId: input.operator.userId,
          sessionId: input.sessionId,
          role: "assistant",
          content: withoutWideDashes(finalContent),
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
        content: withoutWideDashes(finalContent || ""),
        toolCalls: finalToolCalls,
      });
    }

    let pausedForApproval: { approvalRequestId: string; tool: string } | null = null;

    for (const tc of finalToolCalls) {
      if (aborted()) break;
      let parsedArgs: unknown = {};
      try { parsedArgs = JSON.parse(tc.function?.arguments || "{}"); } catch { /* keep raw */ }
      const readKey = (tc.function?.name || "").startsWith("system_") ? `${tc.function.name}:${canonical(parsedArgs)}` : null;
      const again = readKey ? answered.get(readKey) : undefined;
      if (again !== undefined) {
        chatMessages.push({ role: "tool", tool_call_id: tc.id, content: again });
        if (!input.ephemeral) {
          await appendToMemory({
            tenantId: input.operator.tenantId,
            userId: input.operator.userId,
            sessionId: input.sessionId,
            role: "tool",
            content: again,
            toolCallId: tc.id,
            toolName: tc.function?.name || undefined,
          });
        }
        continue;
      }
      const label = stepText(tc.function?.name || "", parsedArgs, input.operator.locale ?? "en");
      await onEvent({
        type: "tool_start",
        toolCallId: tc.id,
        name: tc.function?.name || "unknown",
        args: parsedArgs,
        label,
      });

      const r = await dispatchSystemToolCall(tc, {
        tenantId: input.operator.tenantId,
        userId: input.operator.userId,
        selectedConversationId: ctxBuilt.resolved.conversationId,
        selectedContactId: ctxBuilt.resolved.contactId,
        authToken: input.authToken,
        viewer: input.operator.viewer,
        locale: input.operator.locale ?? "en",
        defaultPeriod: input.defaultPeriod,
        nextId,
        canReadCommerce: !!input.operator.canReadCommerce,
        canReadContacts: !!input.operator.canReadContacts,
        canReadKnowledge: !!input.operator.canReadKnowledge,
      });
      // Other words, same query (a default spelled out): the first card stands.
      const sourceKey = r.artifacts ? canonical((r.artifacts.source as any)?.query ?? null) : null;
      const sameAs = sourceKey ? drawn.get(sourceKey) : undefined;
      if (sameAs !== undefined) {
        r.content = sameAs;
      } else if (r.artifacts) {
        if (sourceKey) drawn.set(sourceKey, r.content);
        await onEvent({ type: "artifacts", toolCallId: tc.id, blocks: r.artifacts.blocks, source: r.artifacts.source });
      }
      if (readKey) answered.set(readKey, r.content);

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
        label,
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
  if (stopReason !== "cancelled" && aborted()) stopReason = "cancelled";
  if (stopReason === "cancelled") await onEvent({ type: "cancelled" });
  if (stopReason === "budget") await onEvent({ type: "error", code: "BUDGET_EXCEEDED", message: "this answer reached its size limit" });

  await onEvent({ type: "done", usage: totalUsage, rounds: round });

  // Best-effort: if the loop terminated with `error`, log; the caller
  // already received the error event.
  if (stopReason === "error") {
    console.warn("[agent-runtime] run terminated with error after", round, "rounds");
  }
}

/** A value as one string, whatever the order of its keys; empty values count as absent. */
export function canonical(v: unknown): string {
  const norm = (x: any): any => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(x).sort()) {
        const val = x[k];
        if (val === undefined || val === null || val === "") continue;
        out[k] = norm(val);
      }
      return out;
    }
    return x;
  };
  return JSON.stringify(norm(v)) ?? "";
}

function summariseToolResult(jsonStr: string): string {
  // Compress noisy JSON down to a single line for the SSE event consumer.
  try {
    const parsed = JSON.parse(jsonStr);
    if (parsed?.ok === false) return `error: ${String(parsed.error || "unknown").slice(0, 120)}`;
    if (Array.isArray(parsed?.results)) return `results: ${parsed.results.length}`;
    // "3 conversations waiting for someone on your team to answer", not "value: 3".
    if (typeof parsed?.count === "number") return parsed.label ? `${parsed.count} ${parsed.label}` : String(parsed.count);
    if (typeof parsed?.value === "number") return parsed.label ? `${parsed.value} ${parsed.label}` : String(parsed.value);
    if (parsed?.proposed_plan) return `plan_proposed`;
    if (parsed?.awaiting_approval) return `awaiting_approval`;
    return "ok";
  } catch {
    return jsonStr.slice(0, 120);
  }
}
