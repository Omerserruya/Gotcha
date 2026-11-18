/**
 * Reply engine v2 - the contract (types only, no behaviour).
 *
 * One turn:
 *   Gate 1 (code: reply at all?)
 *   -> one parallel load (ConversationState, customer card, business + rules, skills, tools, recent messages)
 *   -> ONE model call that sees EVERY tool the employee is allowed (never stage-gated) plus `read_skill`,
 *      and ends by calling `respond` with { reply, state_update, claims }
 *   <-> Gate 2 (code, before each tool: allow / approval / deny), tools in parallel, each with its own timeout
 *   -> Gate 3 (code: claims vs this turn's tool results and state; ONE targeted rewrite, else a safe fixed reply)
 *   -> save state, return the result to the worker (the AI service never sends).
 *
 * Doc: docs/architecture/reply-engine-v2.md
 */

/** The switch, per tenant, on the agent-loop ladder: off (legacy), shadow (legacy replies, v2 evaluated), autonomous (v2 replies). */
export type ReplyEngineMode = "off" | "shadow" | "autonomous";

/** Which ConversationState row a run reads and writes. A shadow run never touches the live row. */
/** replay: a past turn re-run "as of" its message (scripts/replay-v2.ts); writes nothing, like shadow. */
export type StateLane = "live" | "shadow" | "replay";

// ── ConversationState (table conversation_states, one row per conversation per lane) ──

export interface OfferedItem {
  /** The key the model saw this turn or an earlier one (PRODUCT_1) or the store's id. */
  ref: string;
  title: string;
  price?: number | null;
  currency?: string | null;
  productId?: string | null;
  variantId?: string | null;
  at: string;
}

export interface PendingItem {
  /** promise: we said we would do X; pending: waiting for the customer; approval: an action awaits a person. */
  kind: "promise" | "pending" | "approval";
  text: string;
  tool?: string;
  ref?: string;
  at: string;
}

export interface ConversationStateRecord {
  stage: string | null;
  intent: string | null;
  facts: Record<string, string | number | boolean | null>;
  offeredItems: OfferedItem[];
  pending: PendingItem[];
  activeSkill: string | null;
  summary: string | null;
  summaryUpTo: string | null;
  turnCount: number;
}

/** What the model may change. Absent keys keep their value; a null fact value removes the fact. */
export interface StateUpdate {
  stage?: string | null;
  intent?: string | null;
  facts?: Record<string, string | number | boolean | null>;
  /** Replaces the pending list when present (the model restates what is still open). */
  pending?: Array<Pick<PendingItem, "kind" | "text" | "tool">>;
}

// ── The model's final output: the `respond` tool's arguments ──

export type ClaimKind =
  /** A price or amount stated to the customer. */
  | "price"
  /** A product named as existing / in stock / with an attribute. */
  | "product"
  /** Something said to have happened (order checked, coupon made, handed to the team). */
  | "action"
  /** A store fact (shipping, returns, hours) said as fact. */
  | "fact";

export interface Claim {
  kind: ClaimKind;
  /** The claim in a few words, e.g. "Canvas Tote ₪79", "order 1234 shipped". */
  text: string;
  /** The tool call id or tool name whose result backs it; "knowledge" or "state" for those sources. */
  source?: string;
}

export interface ModelTurnOutput {
  reply: string;
  stateUpdate: StateUpdate;
  claims: Claim[];
  /** The model asks for a person: a short reason. */
  handoff?: string | null;
  /** Product keys (PRODUCT_n) to show as cards, when the channel renders cards. */
  cards?: string[];
  /** A question the team must answer later; the AI keeps the conversation (no handoff). */
  teamQuestion?: string | null;
}

// ── Tools: ONE contract for ours, custom API and (later) MCP ──

export type ToolOrigin = "builtin" | "integration" | "custom_api" | "custom_db" | "mcp" | "engine";

/** The gate's verdict before a tool runs (Gate 2). */
export type ToolGateDecision = "allow" | "approval" | "deny";

export interface EngineTool {
  /** The wire name the model calls (sanitized by generateResponse). */
  name: string;
  origin: ToolOrigin;
  /** OpenAI function definition as sent. Descriptions are kept short; the list is sorted by name. */
  definition: Record<string, unknown>;
  /** Per-tool timeout; the default is engineConfig().toolTimeoutMs. */
  timeoutMs?: number;
}

export interface ToolRunRecord {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  decision: ToolGateDecision | "timeout" | "error" | "simulated";
  /** What the model was given back (already summarised for store reads). */
  content: string;
  ms: number;
  /** What the call came back with, for the trace. */
  outcome?: "ok" | "empty" | "error" | "timeout" | "denied" | "approval" | "simulated";
  /** Store results grounded this call. */
  resultCount?: number;
  /** A read retried once after an error or a timeout. */
  retried?: boolean;
  /** A short machine code for an error outcome (reason/code/failure of the result, or tool_error/timeout). Never free text. */
  errorKind?: string;
}

// ── Gate 3 ──

export type ClaimProblem =
  | { kind: "ungrounded_price"; prices: string[] }
  | { kind: "unsupported_action"; claims: string[] }
  | { kind: "unknown_product"; names: string[] }
  | { kind: "style"; codes: string[] }
  /** An attribute question answered "no info" (or sent to the team) without reading the product. */
  | { kind: "unread_product" }
  /** A delivery or order question answered "no info" or sent to the team without the order/tracking tools. */
  | { kind: "unread_order" }
  /** A coupon or policy question sent to the team without searching the knowledge. */
  | { kind: "unread_knowledge" }
  | { kind: "gave_up_search"; fromKnowledge?: boolean }
  | { kind: "ungrounded_absence"; claims: string[] }
  | { kind: "no_search" }
  | { kind: "ignored_yes" }
  | { kind: "nameless_products" }
  | { kind: "card_reference"; claims: string[] }
  | { kind: "echoed_size"; claims: string[] }
  | { kind: "unsafe_tip"; claims: string[] }
  | { kind: "ungrounded_number"; claims: string[] }
  | { kind: "dangling_reference"; claims: string[] }
  | { kind: "no_recommendation" }
  | { kind: "ungrounded_payment"; claims: string[]; teamOpen?: boolean }
  | { kind: "inactive_order_unlabelled"; claims: string[] }
  | { kind: "near_name"; asked: string; shown: string }
  | { kind: "option_without_variation"; claims: string[] }
  | { kind: "not_narrowed"; extra: string[] }
  | { kind: "ungrounded_source"; claims: string[] }
  | { kind: "price_against_store"; claims: string[] }
  | { kind: "order_state_unread"; claims: string[] }
  | { kind: "claims_attachment"; claims: string[] }
  | { kind: "device_mismatch"; claims: string[] }
  | { kind: "ungrounded_negative_fit"; claims: string[]; fits?: string[] }
  | { kind: "ungrounded_positive_fit"; claims: string[] }
  | { kind: "unnamed_recommendation" }
  | { kind: "partial_return_policy" }
  | { kind: "knowledge_has_it" }
  | { kind: "coupon_source" }
  /** A handoff the customer's words do not call for (it would silence the AI). */
  | { kind: "needless_handoff" };

export interface Gate3Verdict {
  ok: boolean;
  problems: ClaimProblem[];
}

// ── The turn's outcome (mapped onto AIBotReplyResult for the worker) ──

export interface EngineTurnTrace {
  engine: "v2";
  mode: ReplyEngineMode;
  lane: StateLane;
  gate1: "reply" | string;
  /** ms per stage: load, model rounds, tools, gate3, save. */
  stageMs: Record<string, number>;
  rounds: number;
  tools: ToolRunRecord[];
  gate3: Gate3Verdict & { rewrite: "none" | "rewritten" | "cleaned" | "cleaned_partial" | "fallback" | "silent" };
  tokens: { input: number; output: number; cached: number };
  toolsOffered: number;
  /** The question recorded for the team this turn (live) or that would have been (shadow, replay). A repeat of an open one is not. */
  teamQuestion?: string | null;
  /** The model asked the team again about an issue already open: not recorded a second time. */
  teamQuestionRepeat?: boolean;
}
