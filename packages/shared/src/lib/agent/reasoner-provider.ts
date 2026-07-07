/**
 * ReasonerProvider — the reasoning engine as a provider abstraction.
 *
 * The platform depends on THIS interface, never on a model vendor. Same shape as
 * the Capability Runtime: the contract lives here (packages/shared, zero exec
 * deps); concrete providers (OpenAI first, then Claude / Gemini / DeepSeek /
 * local / future internal reasoners) live in services/ai and are injected.
 *
 * Permanent:   the Reasoner contract — ReasonerInput → ReasonerOutput.
 * Replaceable: the model implementation behind this interface.
 *
 * HARD RULE: no vendor-specific type ever crosses this boundary. A provider
 * accepts a `ReasonerInput`, returns a validated `ReasonerOutput` + neutral
 * telemetry. Prompt shape, SDK types, token maps, tool formats — all stay inside
 * the provider.
 */

import type { ReasonerInput, ReasonerOutput, ReasonerDecision } from "./cognition";
import { EMPTY_AGENT_MEMORY } from "./memory";

/** Neutral telemetry — no vendor fields. */
export interface ReasonerUsage {
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
}

export interface ReasonerCallOptions {
  /** Cooperative cancellation. */
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Neutral execution context the provider needs to route + meter the call
   * (billing/gating are keyed by tenant; session id enables prompt caching).
   * Platform-level, NOT vendor-specific — it never describes the model.
   */
  context?: { tenantId: string; conversationId?: string; sessionId?: string };
}

export interface ReasonerProviderResult {
  output: ReasonerOutput;
  usage?: ReasonerUsage;
}

/**
 * The reasoning engine. `name`/`model` are opaque labels for telemetry/routing;
 * callers must not branch on the vendor.
 */
export interface ReasonerProvider {
  readonly name: string;
  readonly model: string;
  reason(input: ReasonerInput, opts?: ReasonerCallOptions): Promise<ReasonerProviderResult>;
}

// ── Vendor-neutral output validation ────────────────────────────────────────
// Every provider parses its model's raw JSON, then runs it through THIS so the
// boundary emits only well-formed ReasonerOutputs. Parsing lives once, not per
// vendor. Pure; never throws.

export type ParseResult =
  | { ok: true; output: ReasonerOutput }
  | { ok: false; error: string };

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Coerce an untrusted decision object into a valid ReasonerDecision, or null. */
function parseDecision(d: any): ReasonerDecision | null {
  if (!d || typeof d !== "object") return null;
  switch (d.type) {
    case "EXECUTE":
      if (typeof d.operation !== "string" || !d.operation) return null;
      return { type: "EXECUTE", operation: d.operation, params: (d.params && typeof d.params === "object") ? d.params : {} };
    case "REQUEST_INPUT":
      return { type: "REQUEST_INPUT", needed: asString(d.needed) };
    case "FINISH":
      return { type: "FINISH", reason: asString(d.reason, "goal_reached") };
    case "ESCALATE":
      return { type: "ESCALATE", reason: asString(d.reason, "unspecified") };
    case "CONVERSE":
      return { type: "CONVERSE" };
    case "WAIT":
      return { type: "WAIT" };
    default:
      return null;
  }
}

/**
 * Validate/coerce a parsed model object into a ReasonerOutput. The DECISION is
 * strict (an invalid/absent decision fails — we will not guess a business move);
 * the `read`/`replyIntent`/`memoryUpdate` are coerced to safe shapes.
 */
export function parseReasonerOutput(raw: unknown): ParseResult {
  if (!raw || typeof raw !== "object") return { ok: false, error: "not_an_object" };
  const o = raw as any;

  const decision = parseDecision(o.decision);
  if (!decision) return { ok: false, error: "invalid_decision" };

  const read = o.read && typeof o.read === "object" ? o.read : {};
  const missing = Array.isArray(read.missingInformation) ? read.missingInformation : [];
  const reply = o.replyIntent && typeof o.replyIntent === "object" ? o.replyIntent : {};
  const mem = o.memoryUpdate && typeof o.memoryUpdate === "object" ? o.memoryUpdate : {};

  const output: ReasonerOutput = {
    read: {
      situation: asString(read.situation),
      customerState: asString(read.customerState),
      goal: typeof read.goal === "string" ? read.goal : null,
      missingInformation: missing
        .filter((m: any) => m && typeof m === "object")
        .map((m: any) => ({
          what: asString(m.what),
          why: asString(m.why),
          source: m.source === "system" ? "system" : "customer",
        })),
      rationale: asString(read.rationale),
    },
    decision,
    replyIntent: {
      purpose: asString(reply.purpose),
      keyPoints: asStringArray(reply.keyPoints),
    },
    memoryUpdate: {
      committedGoal: typeof mem.committedGoal === "string" ? mem.committedGoal : undefined,
      workingHypotheses: asStringArray(mem.workingHypotheses),
      alreadyAsked: asStringArray(mem.alreadyAsked),
      priorReads: Array.isArray(mem.priorReads)
        ? mem.priorReads
            .filter((p: any) => p && typeof p === "object")
            .map((p: any) => ({ turn: Number(p.turn) || 0, situation: asString(p.situation) }))
        : EMPTY_AGENT_MEMORY.priorReads,
      openCommitments: asStringArray(mem.openCommitments),
    },
  };
  return { ok: true, output };
}
