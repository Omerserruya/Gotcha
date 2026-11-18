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
import { retrieveRelevantChunks, buildKnowledgeContext, lexicalKnowledge, mergeKnowledge, knowledgeLimit } from "../knowledge.service";
import type { ToolRunRecord, ToolGateDecision, StateLane } from "./contract";
import { findSkill, type EngineSkill } from "./skills";
import { runMcpTool } from "../mcp-servers.service";

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
  /** Why this call may not run on this turn (an unasked write or order read), on every lane; null = it may. */
  refuse?: (tool: string, args: Record<string, unknown>) => string | null;
  toolTimeoutMs: number;
  /** Mutable, turn-wide. */
  turn: TurnTools;
  deps?: Partial<RunnerDeps>;
}

export interface RunnerDeps {
  dispatch: typeof dispatchToolCall;
  mcp: typeof runMcpTool;
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
  const [vector, lexical] = await Promise.all([
    retrieveRelevantChunks(tenantId, query, 5, aiAgentId),
    lexicalKnowledge(tenantId, query, 5, aiAgentId).catch(() => []),
  ]);
  const chunks = mergeKnowledge(vector, lexical, knowledgeLimit(query));
  return buildKnowledgeContext(chunks, { dropWhenAllWeak: true, conflicts: "team" }) || "";
}

async function runOne(env: RunnerEnv, call: ModelToolCall): Promise<ToolRunRecord & { side?: AgentToolDispatchResult["sideEffect"] }> {
  const t0 = Date.now();
  const tool = call.function?.name ?? "";
  const args = redactCardDetailsInArgs(parseArgs(call.function?.arguments));
  const deps: RunnerDeps = {
    dispatch: dispatchToolCall,
    mcp: runMcpTool,
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
  // MCP tools run on the tenant's server; everything else through the shared dispatcher.
  const run = async (ctx: AgentToolContext): Promise<AgentToolDispatchResult> => {
    if (tool.startsWith("mcp.")) {
      if (ctx.sandbox?.enabled && ctx.sandbox.writes === "safe" && !isRead) {
        return { toolCallId: call.id, content: JSON.stringify({ ok: true, tool, status: "done" }), sideEffect: { simulated: true } as any };
      }
      const r = await deps.mcp(env.tenantId, tool, args);
      return { toolCallId: call.id, content: r.content };
    }
    return deps.dispatch({ id: call.id, function: { name: tool, arguments: JSON.stringify(args) } }, ctx);
  };
  const exec = async (): Promise<{ decision: ToolGateDecision | "simulated"; r: AgentToolDispatchResult }> => {
    // Refused on this turn, on every lane, before anything is proposed or simulated (prod rating 2026-11-18:
    // a simulated add_order_note ran on a closing turn, unasked).
    const refused = env.refuse?.(tool, args) ?? null;
    if (refused) return { decision: "deny", r: { toolCallId: call.id, content: JSON.stringify({ ok: false, failure: "refused", reason: refused }) } };
    // Shadow and replay: nothing is written, nothing is proposed.
    if (env.lane !== "live") {
      const v = await deps.evaluate({ tenantId: env.tenantId, toolName: tool, aiAgentId: env.aiAgentId, args });
      if (v.decision === "DENY") return { decision: "deny", r: unwrap(call.id, tool, { status: "denied", error: v.reason, attempts: 0 } as any) };
      if (v.decision === "REQUIRE_APPROVAL" || (!isRead && env.tightenApproval?.({ tool, args }))) {
        return { decision: "simulated", r: { toolCallId: call.id, content: JSON.stringify({ ok: false, status: "awaiting_approval", note: "A person on the team must approve this first." }) } };
      }
      const r = await run({ ...env.ctx, sandbox: { enabled: true, writes: "safe" } });
      // The model on these lanes must act exactly as live, so it never sees a
      // simulation note (prod replay 2026-11-16: "לא בוצעה בפועל בסביבת הבדיקה"
      // reached a reply). A write it was allowed is reported as done, as live would.
      return { decision: isRead ? "allow" : "simulated", r: isRead ? r : { ...r, content: asLiveResult(tool, r.content) } };
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
      () => run(env.ctx),
      { ledger: env.turn.ledger, ctx: { contactId: env.ctx.contactId }, idempotency: true, tightenApproval: env.tightenApproval },
    );
    const r = unwrap(call.id, tool, result);
    const decision: ToolGateDecision = r.sideEffect?.awaitingApproval ? "approval" : r.sideEffect?.denied ? "deny" : "allow";
    return { decision, r };
  };

  let outcome: Awaited<ReturnType<typeof exec>> | typeof TIMEOUT;
  let retried = false;
  const attempt = async () => {
    try { return await withTimeout(exec(), timeoutMs); } catch (err: any) { return { thrown: err } as const; }
  };
  let first: any = await attempt();
  // A read that threw or came back errored is retried once (a write never is).
  // Not one that timed out: it already took the whole budget, and a second try
  // doubled the wait to 16s on slow Smoovee searches (prod replay 2026-11-16).
  if (isRead && first !== TIMEOUT && ("thrown" in first || readErrored(first.r?.content))) {
    retried = true;
    first = await attempt();
  }
  if (first !== TIMEOUT && "thrown" in first) {
    return { ...rec("error", JSON.stringify({ ok: false, reason: "tool_error", detail: String(first.thrown?.message ?? first.thrown).slice(0, 200), note: isProductSearchTool(tool) || /get_product|variation/.test(tool) ? SEARCH_SLOW_NOTE : "Not a catalogue outage. Say you could not check it right now; do not hand over for this." })), outcome: "error", errorKind: "tool_error", retried };
  }
  outcome = first;
  if (outcome === TIMEOUT) {
    console.warn(`[reply-engine] tool ${tool} timed out after ${timeoutMs}ms conv=${env.conversationId}`);
    return { ...rec("timeout", JSON.stringify({ ok: false, reason: "timeout", note: isRead ? (isProductSearchTool(tool) || /get_product|variation/.test(tool) ? SEARCH_SLOW_NOTE : "The lookup did not answer in time. Do not guess; say you could not check it right now. Not a reason to hand over.") : "No confirmation came back in time. Do NOT say it was done; say the team will confirm." })), outcome: "timeout", errorKind: "timeout", retried };
  }

  let content = outcome.r.content;
  let resultCount: number | undefined;
  if (isProductSearchTool(tool) && outcome.decision === "allow") {
    const envlp = await deps.ground({ tenantId: env.tenantId, conversationId: env.conversationId, toolName: tool, rawContent: content }).catch(() => null);
    if (envlp) {
      content = mergeEnvelope(env.turn, envlp, env.locale, env.cardChannel);
      // The shared summary tells the model to say it can't check the catalogue and offer a
      // person (prod replay 8: "the catalogue didn't open for me"). v2: the code stays, the advice does not.
      if (/^PRODUCT_SEARCH_FAILED/.test(content)) content = `PRODUCT_SEARCH_FAILED: ${SEARCH_SLOW_NOTE}`;
      resultCount = envlp.status === "ok" ? envlp.candidates.length : 0;
    }
  }
  if (outcome.decision === "allow" && errorKindOf(content) === "access_denied_cross_customer") content = crossCustomerNote();
  const side = outcome.r.sideEffect;
  if (side?.awaitingApproval) env.turn.approvals.push({ tool, approvalRequestId: String((side.awaitingApproval as any).approvalRequestId ?? call.id) });
  if (side?.escalate) env.turn.escalation = side.escalate as any;
  const out = outcomeOf(outcome.decision, content, resultCount);
  return { ...rec(outcome.decision, content, side), outcome: out, ...(out === "error" ? { errorKind: errorKindOf(content) } : {}), resultCount, retried };
}

/**
 * The order guard refused: what was looked up is not provably this chat's
 * customer (prod replay 2: 9 refusals, the model passing a phone or an email the
 * customer typed). The order number is the way in, never another identifier.
 */
export function crossCustomerNote(): string {
  return JSON.stringify({
    ok: false,
    reason: "access_denied_cross_customer",
    note:
      "This lookup is allowed only for this chat's own customer, and what was given did not match. Reveal nothing about it and do not retry with a phone number or an email. " +
      "If the customer has not given the order number yet, ask for it and look the order up by that number. If an order number was already refused, say the team will check the order and put it in team_question. Not a reason to hand over.",
  });
}

// A slow or failed store search is not the customer's problem (prod replay 3: "I couldn't check the store" where legacy named the category).
const SEARCH_SLOW_NOTE = "The store search did not answer in time. Call it once more with a narrower query (the category, or one or two words, per_page 5). If that fails too, answer from what you know (the categories, the knowledge, what was already shown) and ask what matters to the customer. Never tell the customer you could not check. Not a reason to hand over.";

/** What a live write would have told the model: done, with no word of a test or a simulation. */
export function asLiveResult(tool: string, content: unknown): string {
  try {
    const v = JSON.parse(String(content ?? ""));
    if (v && typeof v === "object" && (v.simulated || /simulat|test conversation|sandbox/i.test(String(v.note ?? "")))) {
      return JSON.stringify({ ok: true, tool, status: "done" });
    }
  } catch { /* not JSON: scrubbed below */ }
  const s = String(content ?? "");
  return /simulat|sandbox|test conversation|not performed/i.test(s) ? JSON.stringify({ ok: true, tool, status: "done" }) : s;
}

/** A short code for an errored result: its reason/code/failure/error field when that is a code, else "error". Never free text. */
export function errorKindOf(content: unknown): string {
  const s = String(content ?? "");
  if (/^PRODUCT_SEARCH_FAILED/.test(s)) return "product_search_failed";
  try {
    const v = JSON.parse(s);
    for (const k of ["reason", "code", "errorCode", "error", "failure", "status"]) {
      const x = v?.[k];
      if (typeof x !== "string") continue;
      if (/^[A-Za-z][A-Za-z0-9_.-]{1,40}$/.test(x)) return x.toLowerCase();
      // "access_denied: requester identity ..." -> its leading code only, never the text after it.
      const lead = /^([a-z][a-z0-9_]{2,40}):/.exec(x);
      if (lead) return lead[1];
    }
    if (typeof v?.httpStatus === "number" || typeof v?.statusCode === "number") return `http_${v.httpStatus ?? v.statusCode}`;
  } catch { /* not JSON */ }
  return "error";
}

/** A read whose result is a failure (not an empty result). */
export function readErrored(content: unknown): boolean {
  const c = String(content ?? "");
  return /^PRODUCT_SEARCH_FAILED/.test(c) || /"ok"\s*:\s*false[^}]*"failure"\s*:\s*"errored"/.test(c) || /"reason"\s*:\s*"(?:timeout|tool_error)"/.test(c);
}

export function outcomeOf(decision: string, content: string, resultCount?: number): NonNullable<ToolRunRecord["outcome"]> {
  if (decision === "deny") return "denied";
  if (decision === "approval") return "approval";
  if (decision === "simulated") return "simulated";
  if (readErrored(content) || /"ok"\s*:\s*false/.test(content)) return "error";
  if (resultCount === 0 || /0 products matched/.test(content)) return "empty";
  return "ok";
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
