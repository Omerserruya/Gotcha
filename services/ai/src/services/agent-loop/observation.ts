/**
 * Observation — the neutral projection of a Runtime ExecutionResult (+ its trace)
 * back into the loop. This is what "re-enters" the Reasoner: a provider-neutral
 * summary of what the world did, never the raw provider payload.
 */

import type { ExecutionResult, ExecutionTrace } from "@chatcenter/shared";

export interface Observation {
  operation: string;
  /** ExecutionResult status: EXECUTED / NEEDS_INPUT / RECOMMENDED / AWAITING_APPROVAL / BLOCKED / FAILED. */
  status: ExecutionResult["status"];
  outcome?: string;
  reason?: string;
  recoverable?: boolean;
  /**
   * Bounded projection of the result's `data` payload — what a READ actually
   * returned (knowledge passages, CRM context, custom-tool rows). Without this
   * the Reasoner learns THAT a read succeeded but never WHAT it said, making
   * KNOWLEDGE/CUSTOM/CRM reads useless. Hard-capped so a fat provider payload
   * can never blow up the prompt or the persisted iteration row.
   */
  data?: string;
  /** Compact invariant story from the trace (id:outcome, …) — audit-grade WHY. */
  invariantSummary: string;
}

// ── Bounded data projection ──
const MAX_STRING_CHARS = 400; // per leaf string
const MAX_ARRAY_ITEMS = 10; // per array
const MAX_DATA_CHARS = 1800; // whole projection
const MAX_DEPTH = 4;

function boundValue(v: unknown, depth: number): unknown {
  if (v == null) return v;
  if (typeof v === "string") return v.length > MAX_STRING_CHARS ? `${v.slice(0, MAX_STRING_CHARS)}…[+${v.length - MAX_STRING_CHARS} chars]` : v;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (depth >= MAX_DEPTH) return "[…]";
  if (Array.isArray(v)) {
    const items = v.slice(0, MAX_ARRAY_ITEMS).map((x) => boundValue(x, depth + 1));
    if (v.length > MAX_ARRAY_ITEMS) items.push(`…[+${v.length - MAX_ARRAY_ITEMS} more]`);
    return items;
  }
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = boundValue(val, depth + 1);
    return out;
  }
  return String(v);
}

/** Project a result `data` payload to a bounded, prompt-safe string. */
export function projectData(data: Record<string, unknown> | undefined): string | undefined {
  if (!data || Object.keys(data).length === 0) return undefined;
  try {
    const s = JSON.stringify(boundValue(data, 0));
    return s.length > MAX_DATA_CHARS ? `${s.slice(0, MAX_DATA_CHARS)}…[truncated]` : s;
  } catch {
    return undefined;
  }
}

export function projectObservation(
  operation: string,
  result: ExecutionResult,
  trace?: ExecutionTrace,
): Observation {
  const invariantSummary = (trace?.invariants ?? []).map((i) => `${i.id}:${i.outcome}`).join(",");
  const base: Observation = { operation, status: result.status, invariantSummary };
  switch (result.status) {
    case "EXECUTED":
      return { ...base, outcome: result.outcome, data: projectData(result.data) };
    case "NEEDS_INPUT":
      return { ...base, reason: `needs:${result.field} (${result.reason})` };
    case "RECOMMENDED":
      return { ...base, outcome: `recommended ${result.proposal.operation}` };
    case "AWAITING_APPROVAL":
      return { ...base, reason: `awaiting_approval:${result.ref}` };
    case "BLOCKED":
      return { ...base, reason: result.reason };
    case "FAILED":
      return { ...base, reason: result.reason, recoverable: result.recoverable, data: projectData(result.data) };
    default:
      return base;
  }
}

/** One-line rendering for the working-memory trail and the next reason() prompt. */
export function observationLine(o: Observation): string {
  const detail = o.outcome ?? o.reason ?? "";
  const data = o.data ? ` | data: ${o.data}` : "";
  return `${o.operation} → ${o.status}${detail ? `: ${detail}` : ""}${data}`;
}
