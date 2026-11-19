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
import { headNoun, productsOfNoun } from "./gates";
import { runMcpTool } from "../mcp-servers.service";

export interface ModelToolCall {
  id: string;
  function: { name: string; arguments?: string };
}

export interface RunnerEnv {
  /** The customer's message this turn: a search with none of her noun's products is retried on the noun. */
  incoming?: string;
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
  /** The arguments as the store is asked them (the engine's own cleaning): the record holds these. */
  prepare?: (tool: string, args: Record<string, unknown>) => Record<string, unknown>;
  /**
   * The engine's own lookup before an allowed call runs (a product named instead of keyed), at most `budgetMs`:
   * the arguments to call with, or the result to return at once; null = the call as it is. Never for a call the
   * turn refused or the policy did not allow.
   */
  before?: (tool: string, args: Record<string, unknown>, budgetMs: number) => Promise<{ args: Record<string, unknown> } | { content: string } | null>;
  toolTimeoutMs: number;
  /**
   * Time the lookup may take on top of the call's own bound (lookupExtraMs). None (the default): the lookup and the
   * call share the bound, so a round narrowed for time never runs over it.
   */
  lookupExtraMs?: number;
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
/** The same, with a clock the work itself can give time back to (`more`): what it spent that is not on this clock. */
function withClock<T>(work: (more: (ms: number) => void) => Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let end = Date.now() + ms;
  let timer: NodeJS.Timeout | undefined;
  let open = true;
  return new Promise<T | typeof TIMEOUT>((resolve, reject) => {
    const arm = () => { timer = setTimeout(() => (Date.now() >= end ? resolve(TIMEOUT) : arm()), Math.max(0, end - Date.now())); };
    arm();
    Promise.resolve()
      .then(() => work((more) => { if (open && more > 0) { end += more; clearTimeout(timer); arm(); } }))
      .then(resolve, reject);
  }).finally(() => { open = false; clearTimeout(timer); });
}

/** The engine's lookup before a call takes at most this long, and at most this much on top of the call's own bound. */
export const LOOKUP_MS = 3000;
/**
 * The time a round's lookup gets on top of the round's tool bound: what the turn's hard ceiling leaves after the
 * bound and the time kept for the answer, never more than LOOKUP_MS and never below zero. So a call with a
 * lookup ends no later than the round was allowed to end, and a turn is never pushed past its ceiling by one.
 */
export function lookupExtraMs(boundMs: number, ceilingLeftMs: number, keepMs: number): number {
  const room = Math.floor(ceilingLeftMs - keepMs - boundMs);
  return Number.isFinite(room) ? Math.max(0, Math.min(LOOKUP_MS, room)) : 0;
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

/** A how-to or video ask: the business's linked guides are part of the answer (prod rating 2026-11-18, NE'A). */
const HOWTO_ASK = /(?<![\u0590-\u05FF])[וה]?(?:סרטון|סרטונים|הדרכה|הדרכות|מדריך|קישור|לינק|איך)(?![\u0590-\u05FF])|\b(?:video|tutorial|guide|how to|how do|link)\b/iu;
export async function defaultKnowledge(tenantId: string, query: string, aiAgentId: string, deps: { vector?: typeof retrieveRelevantChunks; lexical?: typeof lexicalKnowledge } = {}): Promise<string> {
  const vec = deps.vector ?? retrieveRelevantChunks;
  const lex = deps.lexical ?? lexicalKnowledge;
  const howto = HOWTO_ASK.test(query);
  const [vector, lexical, linked] = await Promise.all([
    vec(tenantId, query, 5, aiAgentId),
    lex(tenantId, query, 5, aiAgentId).catch(() => []),
    // The chunks that carry a link, for the same words: a guide's YouTube link sits in its own chunk.
    howto ? lex(tenantId, `${query} youtube youtu http`, 8, aiAgentId).then((l) => l.filter((c) => /https?:\/\//i.test(c.content))).catch(() => []) : Promise.resolve([]),
  ]);
  const merged = mergeKnowledge(vector, lexical, knowledgeLimit(query));
  const seen = new Set(merged.map((c) => `${c.documentId ?? c.documentTitle}#${c.chunkIndex}`));
  const chunks = [...merged, ...linked.filter((c) => !seen.has(`${c.documentId ?? c.documentTitle}#${c.chunkIndex}`)).slice(0, 2)];
  return buildKnowledgeContext(chunks, { dropWhenAllWeak: true, conflicts: "team" }) || "";
}

async function runOne(env: RunnerEnv, call: ModelToolCall): Promise<ToolRunRecord & { side?: AgentToolDispatchResult["sideEffect"] }> {
  const t0 = Date.now();
  const tool = call.function?.name ?? "";
  let args = redactCardDetailsInArgs(parseArgs(call.function?.arguments));
  // A query of filter words only ("מבצע", "sale", "חדש") is that filter with no query (dev round k5 on 0b5f2b46: "מה יש
  // במבצע?" was refused as no product word and answered with one scarf).
  if (/^woocommerce\.list_products$/.test(String(call.function?.name ?? ""))) args = filterWordsQuery(args);
  if (env.prepare) args = env.prepare(tool, args) as any;
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
  // One order's read (by id or number, its tracking) gets 10s and one retry on a timeout (prod 2026-11-18,
  // Smoovee 376b13: get_order 97837 timed out at 8s on a slow store).
  const singleOrder = SINGLE_ORDER_READ.test(tool);
  const timeoutMs = singleOrder ? Math.max(env.toolTimeoutMs, orderReadTimeoutMs()) : isRead ? env.toolTimeoutMs : Math.max(env.toolTimeoutMs * 3, 20000);
  // The engine's lookup before the call (prod replay e, L1437: a product named by name was searched and then read
  // inside one 7.5s budget, and the read timed out). It runs here, so only for a call that was not refused and that
  // the policy allowed; once per call; at most half the call's bound, or the round's extra time when that is more.
  // The call's clock gets back what the lookup took, up to that extra: with none, the two share the bound.
  let looked = false;
  const lookup = async (more: (ms: number) => void): Promise<AgentToolDispatchResult | null> => {
    if (!env.before || looked) return null;
    looked = true;
    const extra = Math.max(0, Math.floor(env.lookupExtraMs ?? 0));
    const s0 = Date.now();
    const b = await Promise.resolve().then(() => env.before!(tool, args, Math.max(extra, Math.floor(timeoutMs / 2)))).catch(() => null);
    more(Math.min(extra, Date.now() - s0));
    if (b && "content" in b) return { toolCallId: call.id, content: b.content };
    if (b && "args" in b) args = b.args as any;
    return null;
  };
  // MCP tools run on the tenant's server; everything else through the shared dispatcher.
  const run = async (ctx: AgentToolContext, more: (ms: number) => void): Promise<AgentToolDispatchResult> => {
    const answered = await lookup(more);
    if (answered) return answered;
    if (tool.startsWith("mcp.")) {
      if (ctx.sandbox?.enabled && ctx.sandbox.writes === "safe" && !isRead) {
        return { toolCallId: call.id, content: JSON.stringify({ ok: true, tool, status: "done" }), sideEffect: { simulated: true } as any };
      }
      const r = await deps.mcp(env.tenantId, tool, args);
      return { toolCallId: call.id, content: r.content };
    }
    return deps.dispatch({ id: call.id, function: { name: tool, arguments: JSON.stringify(args) } }, ctx);
  };
  const exec = async (more: (ms: number) => void): Promise<{ decision: ToolGateDecision | "simulated"; r: AgentToolDispatchResult }> => {
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
      const r = await run({ ...env.ctx, sandbox: { enabled: true, writes: "safe" } }, more);
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
      () => run(env.ctx, more),
      { ledger: env.turn.ledger, ctx: { contactId: env.ctx.contactId }, idempotency: true, tightenApproval: env.tightenApproval },
    );
    const r = unwrap(call.id, tool, result);
    const decision: ToolGateDecision = r.sideEffect?.awaitingApproval ? "approval" : r.sideEffect?.denied ? "deny" : "allow";
    return { decision, r };
  };

  let outcome: Awaited<ReturnType<typeof exec>> | typeof TIMEOUT;
  let retried = false;
  const attempt = async () => {
    try { return await withClock(exec, timeoutMs); } catch (err: any) { return { thrown: err } as const; }
  };
  let first: any = await attempt();
  // A read that threw or came back errored is retried once (a write never is).
  // Not one that timed out: it already took the whole budget, and a second try
  // doubled the wait to 16s on slow Smoovee searches (prod replay 2026-11-16).
  if (isRead && ((first === TIMEOUT && singleOrder) || (first !== TIMEOUT && ("thrown" in first || readErrored(first.r?.content))))) {
    retried = true;
    first = await attempt();
  }
  if (first !== TIMEOUT && "thrown" in first) {
    return { ...rec("error", JSON.stringify({ ok: false, reason: "tool_error", detail: String(first.thrown?.message ?? first.thrown).slice(0, 200), note: isProductSearchTool(tool) || /get_product|variation/.test(tool) ? SEARCH_SLOW_NOTE : ORDER_READ.test(tool) ? ORDER_FAILED_NOTE : "Not a catalogue outage. Say you could not check it right now; do not hand over for this." })), outcome: "error", errorKind: "tool_error", retried };
  }
  outcome = first;
  if (outcome === TIMEOUT) {
    console.warn(`[reply-engine] tool ${tool} timed out after ${timeoutMs}ms conv=${env.conversationId}`);
    return { ...rec("timeout", JSON.stringify({ ok: false, reason: "timeout", note: isRead ? (isProductSearchTool(tool) || /get_product|variation/.test(tool) ? SEARCH_SLOW_NOTE : ORDER_READ.test(tool) ? ORDER_FAILED_NOTE : "The lookup did not answer in time. Do not guess; say you could not check it right now. Not a reason to hand over.") : "No confirmation came back in time. Do NOT say it was done; say the team will confirm." })), outcome: "timeout", errorKind: "timeout", retried };
  }

  let content = outcome.r.content;
  let resultCount: number | undefined;
  // Not a result the engine itself gave for the call's arguments (unknown_product): that is no store failure, and
  // read as one it reached the model as "the store search did not answer in time", without its candidates.
  if (isProductSearchTool(tool) && outcome.decision === "allow" && errorKindOf(content) !== "unknown_product") {
    let envlp = await deps.ground({ tenantId: env.tenantId, conversationId: env.conversationId, toolName: tool, rawContent: content }).catch(() => null);
    // Results, and none of them is her noun (C pinned rating, Tehila: "בובון לקשירה נמוכה" gave 10 and the cards
    // were scarves): once more on the noun alone, and its results are used when they hold her noun.
    const noun = env.incoming ? headNoun(env.incoming) : null;
    const bare = noun ? noun.replace(/^ה(?=[\u0590-\u05FF]{3,})/u, "") : "";
    // Only titles in her noun's own script are evidence of another kind ("Canvas Tote" may be the "תיק" she asked).
    const sameScript = (x: string) => /[\u0590-\u05FF]/.test(x) === /[\u0590-\u05FF]/.test(bare);
    if (envlp?.status === "ok" && envlp.candidates.length && bare && envlp.candidates.every((c: any) => sameScript(String(c?.title ?? ""))) && !productsOfNoun(envlp.candidates as any[], env.incoming ?? "") && String(args.query ?? "").trim() !== bare) {
      const before = args;
      args = { ...args, query: bare };
      delete (args as any).customer_query;
      const again: any = await attempt();
      const second = again !== TIMEOUT && !("thrown" in again) && again.decision === "allow"
        ? await deps.ground({ tenantId: env.tenantId, conversationId: env.conversationId, toolName: tool, rawContent: again.r.content }).catch(() => null)
        : null;
      if (second?.status === "ok" && productsOfNoun(second.candidates as any[], env.incoming ?? "")) {
        envlp = second;
        outcome = again as Exclude<typeof outcome, typeof TIMEOUT>;
        (env.turn as any).nounResearch = { query: bare, count: second.candidates.length };
      } else {
        args = before;
      }
    }
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
/** A short, stable summary of a call's arguments for the feed: keys and short values, at most 200 characters. */
export function argsSummary(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  return Object.entries(args as Record<string, unknown>).map(([k, v]) => `${k}=${typeof v === "object" ? "[…]" : String(v).slice(0, 40)}`).join(" ").slice(0, 200);
}
/**
 * The failure code of a call, or null when it ran: timeout, tool_error, refused:<why>, denied, http_<status>, or
 * the result's own failure. Read from the record and its result, never guessed.
 */
export function errorCodeOf(r: { outcome?: string; errorKind?: string; decision?: string; content?: string }): string | null {
  if (r.outcome === "timeout") return "timeout";
  let body: any = null;
  try { body = JSON.parse(String(r.content ?? "")); } catch { body = null; }
  if (body?.failure === "refused") return `refused:${String(body.reason ?? "").split(":")[0] || "unknown"}`.slice(0, 60);
  if (r.decision === "deny" || body?.status === "denied") return "denied";
  const status = Number(body?.status ?? body?.httpStatus ?? body?.statusCode);
  if (r.outcome === "error" || r.errorKind) {
    if (Number.isFinite(status) && status >= 400) return `http_${status}`;
    return String(r.errorKind ?? body?.reason ?? "tool_error").slice(0, 60);
  }
  if (body && body.ok === false) return String(body.failure ?? body.reason ?? body.error ?? "failed").slice(0, 60);
  return null;
}

/** One order's own reads (tracking included): a longer wait and a retry. */
export const SINGLE_ORDER_READ = /^(?:woocommerce\.(?:get_order|get_shipment_tracking)|shopify\.(?:get_order|order_lookup|find_latest_order))$/;
/** Every order read, of both stores. */
export const ORDER_READ = /^(?:woocommerce\.(?:get_order|list_customer_orders|list_orders|get_shipment_tracking|list_order_notes|list_refunds)|shopify\.(?:get_order|order_lookup|get_orders|search_orders|get_customer_orders|find_latest_order))$/;
export const ORDER_READ_TIMEOUT_MS = 10_000;
/** REPLY_ENGINE_ORDER_TIMEOUT_MS, 100 to 60000; else 10s (and one retry: 20s worst case). */
export const orderReadTimeoutMs = (env: NodeJS.ProcessEnv = process.env) => { const n = Number(env.REPLY_ENGINE_ORDER_TIMEOUT_MS); return Number.isFinite(n) && n >= 100 && n <= 60000 ? n : ORDER_READ_TIMEOUT_MS; };
/** An order read that failed goes to the team (the engine records the item): the model says so, nothing else. */
export const ORDER_FAILED_NOTE = "The order could not be read right now. Do not guess its state and do not say you could not check it: the team gets this order now, say it was passed to the team.";

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
          // outcome and errorCode feed the platform's failed-action feed (2026-11-18, SYSTEM_ADMIN only).
          metadata: { tool: record.tool, args: record.args, argsSummary: argsSummary(record.args), decision: record.decision, outcome: (record as any).outcome ?? null, errorCode: errorCodeOf(record), result: record.content.slice(0, 500), source: "reply_engine_v2", toolCallId: record.callId, ms: record.ms } as any,
        },
      }).catch(() => {});
    }
  }
  return out.map(({ side, ...r }) => r);
}

const SALE_WORDS = /^(?:מבצע|מבצעים|במבצע|הנחה|הנחות|בהנחה|sale|sales|on|discount|discounts|deals?)$/iu;
const NEW_WORDS = /^(?:חדש|חדשים|חדשות|חדשה|new|newest|latest|arrivals)$/iu;
/** A store search whose query is filter words only becomes that filter with an empty query. */
export function filterWordsQuery(args: any): any {
  const q = String(args?.query ?? "").trim();
  const words = q.split(/\s+/).filter(Boolean);
  if (!words.length) return args;
  if (words.every((w) => SALE_WORDS.test(w)) && words.some((w) => !/^on$/i.test(w))) return { ...args, query: "", on_sale: true };
  if (words.every((w) => NEW_WORDS.test(w) || SALE_WORDS.test(w)) && words.some((w) => NEW_WORDS.test(w))) return { ...args, query: "", ...(words.some((w) => SALE_WORDS.test(w) && !/^on$/i.test(w)) ? { on_sale: true } : {}) };
  return args;
}
