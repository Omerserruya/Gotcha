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
export type StateLane = "live" | "shadow";

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
}

// ── Gate 3 ──

export type ClaimProblem =
  | { kind: "ungrounded_price"; prices: string[] }
  | { kind: "unsupported_action"; claims: string[] }
  | { kind: "unknown_product"; names: string[] }
  | { kind: "style"; codes: string[] };

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
  gate3: Gate3Verdict & { rewrite: "none" | "rewritten" | "fallback" };
  tokens: { input: number; output: number; cached: number };
  toolsOffered: number;
}
