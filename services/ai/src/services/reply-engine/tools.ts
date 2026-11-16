/**
 * Gate 2 + the tool runner. Every model tool call of a round runs in parallel,
 * each with its own timeout, each through the gate first:
 *   live   - ActionOrchestrator.submit: evaluatePolicies (with aiAgentId), HITL
 *            approval, business policy caps, idempotency ledger, and the active
 *            skill's approvalOverAmount as tightenApproval.
 *   shadow - evaluatePolicies only. A read runs for real; a write or an approval
 *            is SIMULATED (sandbox "safe"): no approval request, no tool row.
 * Store searches are grounded into one turn-wide envelope; the model sees keyed
 * summaries (PRODUCT_n), never raw ids or URLs.
 */
import { randomUUID } from "crypto";
import {
  prisma,
  dispatchToolCall,
  evaluatePolicies,
  classifyToolEffect,
  type AgentToolContext,
  type AgentToolDispatchResult,
} from "@chatcenter/shared";
import { getActionOrchestrator, type ExecutionResult } from "../orchestrator";
import { TurnOutcomeLedger } from "../turn-outcome-ledger";
import { redactCardDetailsInArgs } from "../card-details-guard";
import { isProductSearchTool, groundProductSearchResult } from "../discovery-integration.service";
import { buildKeyedModelSummary, type ProductSearchEnvelope } from "../product-search.service";
import { retrieveRelevantChunks, buildKnowledgeContext } from "../knowledge.service";
import type { ToolRunRecord, ToolGateDecision, StateLane } from "./contract";
import { findSkill, type EngineSkill } from "./skills";

export interface ModelToolCall {
  id: string;
  function: { name: string; arguments?: string };
}

export interface RunnerEnv {
  tenantId: string;
  conversationId: string;
  aiAgentId: string;
  lane: StateLane;
  locale: "he" | "en";
  cardChannel: boolean;
  ctx: AgentToolContext;
  skills: EngineSkill[];
  /** Tighten-only approval hook (the active business skill's approvalOverAmount). */
  tightenApproval?: (a: { tool: string; args?: unknown }) => string | null;
  toolTimeoutMs: number;
  /** Mutable, turn-wide. */
  turn: TurnTools;
  deps?: Partial<RunnerDeps>;
}

export interface RunnerDeps {
  dispatch: typeof dispatchToolCall;
  evaluate: typeof evaluatePolicies;
  submit: (proposal: any, exec: () => Promise<AgentToolDispatchResult>, opts: any) => Promise<ExecutionResult>;
  ground: typeof groundProductSearchResult;
  knowledge: (tenantId: string, query: string, aiAgentId: string) => Promise<string>;
}

export interface TurnTools {
  ledger: TurnOutcomeLedger;
  /** Every store candidate this turn, keys PRODUCT_1..N across all searches. */
  envelope: ProductSearchEnvelope | null;
  records: ToolRunRecord[];
  approvals: Array<{ tool: string; approvalRequestId: string }>;
  escalation: { reason: string; priority?: string; summary?: string } | null;
  openedSkill: string | null;
  knowledgeText: string[];
}

export function newTurnTools(): TurnTools {
  return { ledger: new TurnOutcomeLedger(), envelope: null, records: [], approvals: [], escalation: null, openedSkill: null, knowledgeText: [] };
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function unwrap(callId: string, tool: string, exec: ExecutionResult): AgentToolDispatchResult {
  if (exec.status === "completed") {
    const inner = exec.result as AgentToolDispatchResult | undefined;
    if (inner && typeof inner === "object" && "content" in inner) return { ...inner, toolCallId: callId };
    return { toolCallId: callId, content: typeof inner === "string" ? inner : "" };
  }
  if (exec.status === "proposed") {
    return {
      toolCallId: callId,
      content: JSON.stringify({ ok: false, status: "awaiting_approval", note: "A person on the team must approve this first. Tell the customer it was passed on for confirmation; do not say it was done." }),
      sideEffect: { awaitingApproval: { approvalRequestId: callId, tool } as any },
    };
  }
  if (exec.status === "denied") {
    return {
      toolCallId: callId,
      content: JSON.stringify({ ok: false, status: "denied", reason: exec.error ?? "policy", note: "Not allowed. Do not retry; offer a person if the customer needs it." }),
      sideEffect: { denied: { reason: exec.error ?? "policy" } as any },
    };
  }
  return { toolCallId: callId, content: JSON.stringify({ ok: false, status: "failed", reason: exec.error ?? "unknown error" }) };
}

const TIMEOUT = Symbol("timeout");
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<typeof TIMEOUT>((r) => { timer = setTimeout(() => r(TIMEOUT), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** Append a search's candidates to the turn envelope and renumber its keys to match. */
export function mergeEnvelope(turn: TurnTools, env: ProductSearchEnvelope, locale: "he" | "en", cards: boolean): string {
  const offset = turn.envelope?.candidates.length ?? 0;
  const summary = buildKeyedModelSummary(env, locale, cards);
  if (env.status !== "ok" || !env.candidates.length) {
    if (!turn.envelope) turn.envelope = { ...env, candidates: [] };
    return summary;
  }
  turn.envelope = turn.envelope
    ? { ...env, candidates: [...turn.envelope.candidates, ...env.candidates] }
    : { ...env, candidates: [...env.candidates] };
  return offset ? summary.replace(/PRODUCT_(\d+)/g, (_, n) => `PRODUCT_${Number(n) + offset}`) : summary;
}

async function defaultKnowledge(tenantId: string, query: string, aiAgentId: string): Promise<string> {
  const chunks = await retrieveRelevantChunks(tenantId, query, 5, aiAgentId);
  return buildKnowledgeContext(chunks, { dropWhenAllWeak: true }) || "";
}

async function runOne(env: RunnerEnv, call: ModelToolCall): Promise<ToolRunRecord & { side?: AgentToolDispatchResult["sideEffect"] }> {
  const t0 = Date.now();
  const tool = call.function?.name ?? "";
  const args = redactCardDetailsInArgs(parseArgs(call.function?.arguments));
  const deps: RunnerDeps = {
    dispatch: dispatchToolCall,
    evaluate: evaluatePolicies,
    submit: (p, e, o) => getActionOrchestrator().submit(p, e, o),
    ground: groundProductSearchResult,
    knowledge: defaultKnowledge,
    ...env.deps,
  };
  const rec = (decision: ToolRunRecord["decision"], content: string, side?: AgentToolDispatchResult["sideEffect"]) => ({
    callId: call.id, tool, args, decision, content, ms: Date.now() - t0, side,
  });

  // ── Engine tools ──
  if (tool === "read_skill") {
    const s = findSkill(env.skills, args.name);
    if (!s) return rec("allow", JSON.stringify({ ok: false, reason: "no such skill", skills: env.skills.map((k) => k.name) }));
    env.turn.openedSkill = s.name;
    return rec("allow", s.render());
  }
  if (tool === "search_knowledge") {
    const q = String(args.query ?? "").slice(0, 300);
    const out = q ? await withTimeout(deps.knowledge(env.tenantId, q, env.aiAgentId).catch(() => ""), env.toolTimeoutMs) : "";
    const text = out === TIMEOUT ? "" : out;
    if (text) env.turn.knowledgeText.push(text);
    return rec("allow", text || "No document matched. Do not guess the answer; offer to check with the team.");
  }

  // ── Gate 2 + execution ──
  const isRead = classifyToolEffect(tool) === "read";
  const timeoutMs = isRead ? env.toolTimeoutMs : Math.max(env.toolTimeoutMs * 3, 20000);
  const exec = async (): Promise<{ decision: ToolGateDecision | "simulated"; r: AgentToolDispatchResult }> => {
    if (env.lane === "shadow") {
      const v = await deps.evaluate({ tenantId: env.tenantId, toolName: tool, aiAgentId: env.aiAgentId, args });
      if (v.decision === "DENY") return { decision: "deny", r: unwrap(call.id, tool, { status: "denied", error: v.reason, attempts: 0 } as any) };
      if (v.decision === "REQUIRE_APPROVAL" || (!isRead && env.tightenApproval?.({ tool, args }))) {
        return { decision: "simulated", r: { toolCallId: call.id, content: JSON.stringify({ ok: false, status: "awaiting_approval", simulated: true, note: "A person on the team must approve this first." }) } };
      }
      const r = await deps.dispatch({ id: call.id, function: { name: tool, arguments: JSON.stringify(args) } }, { ...env.ctx, sandbox: { enabled: true, writes: "safe" } });
      return { decision: isRead ? "allow" : "simulated", r };
    }
    const result = await deps.submit(
      {
        id: randomUUID(),
        conversationId: env.conversationId,
        tenantId: env.tenantId,
        proposedBy: { mode: "chat", system: "reply-engine-v2" },
        actor: { agentId: "" },
        aiAgentId: env.aiAgentId,
        tool,
        args,
        rationale: "reply engine v2 tool call",
        urgency: "low",
      },
      () => deps.dispatch({ id: call.id, function: { name: tool, arguments: JSON.stringify(args) } }, env.ctx),
      { ledger: env.turn.ledger, ctx: { contactId: env.ctx.contactId }, idempotency: true, tightenApproval: env.tightenApproval },
    );
    const r = unwrap(call.id, tool, result);
    const decision: ToolGateDecision = r.sideEffect?.awaitingApproval ? "approval" : r.sideEffect?.denied ? "deny" : "allow";
    return { decision, r };
  };

  let outcome: Awaited<ReturnType<typeof exec>> | typeof TIMEOUT;
  try {
    outcome = await withTimeout(exec(), timeoutMs);
  } catch (err: any) {
    return rec("error", JSON.stringify({ ok: false, reason: "tool_error", detail: String(err?.message ?? err).slice(0, 200) }));
  }
  if (outcome === TIMEOUT) {
    console.warn(`[reply-engine] tool ${tool} timed out after ${timeoutMs}ms conv=${env.conversationId}`);
    return rec("timeout", JSON.stringify({ ok: false, reason: "timeout", note: isRead ? "The lookup did not answer in time. Do not guess; say you could not check it right now." : "No confirmation came back in time. Do NOT say it was done; say the team will confirm." }));
  }

  let content = outcome.r.content;
  if (isProductSearchTool(tool) && outcome.decision === "allow") {
    const envlp = await deps.ground({ tenantId: env.tenantId, conversationId: env.conversationId, toolName: tool, rawContent: content }).catch(() => null);
    if (envlp) content = mergeEnvelope(env.turn, envlp, env.locale, env.cardChannel);
  }
  const side = outcome.r.sideEffect;
  if (side?.awaitingApproval) env.turn.approvals.push({ tool, approvalRequestId: String((side.awaitingApproval as any).approvalRequestId ?? call.id) });
  if (side?.escalate) env.turn.escalation = side.escalate as any;
  return rec(outcome.decision, content, side);
}

/** Run one round's calls in parallel; records land on env.turn in call order. */
export async function runToolRound(env: RunnerEnv, calls: ModelToolCall[]): Promise<ToolRunRecord[]> {
  const out = await Promise.all(calls.map((c) => runOne(env, c)));
  // Store envelopes were merged as results arrived; key order follows arrival, which
  // only matters for two searches in one round, and both summaries carry their own keys.
  for (const r of out) {
    const { side, ...record } = r;
    env.turn.records.push(record);
    if (env.lane === "live") {
      prisma.auditLog.create({
        data: {
          tenantId: env.tenantId,
          actorType: "ai",
          action: `ai.tool_call.${record.tool}`,
          targetType: "conversation",
          targetId: env.conversationId,
          metadata: { tool: record.tool, args: record.args, decision: record.decision, result: record.content.slice(0, 500), source: "reply_engine_v2", toolCallId: record.callId, ms: record.ms } as any,
        },
      }).catch(() => {});
    }
  }
  return out.map(({ side, ...r }) => r);
}
