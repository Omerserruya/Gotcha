/**
 * Call state machine — typed transitions for VoiceCallSession.
 *
 * Replaces the previous untyped `status` string handling with an explicit
 * FSM. Dual-write window: both the new `state` column and the legacy
 * `status` string are populated by transition writers so existing readers
 * (analytics, dashboards) keep working unchanged. After the dual-write
 * observation period the legacy column becomes read-only.
 *
 * Invalid transitions throw `InvalidTransitionError`. Callers should treat
 * that as a bug indicator — the upper layer either has a state-tracking
 * defect or a stale read. The route handler maps it to HTTP 422 + alert
 * (see "webhook failure handling" plan).
 */

export type CallState =
  | "RINGING"
  | "CONNECTING"
  | "ACTIVE"
  | "HOLD"
  | "ENDED"
  | "FAILED"
  | "MISSED";

export type LegacyCallStatus =
  | "ringing"
  | "in-progress"
  | "completed"
  | "failed"
  | "no-answer";

/** Terminal states that have no outgoing transitions. */
export const TERMINAL_STATES: ReadonlySet<CallState> = new Set([
  "ENDED",
  "FAILED",
  "MISSED",
]);

/** Live (non-terminal, agent-attached) states for "is on a call" checks. */
export const LIVE_STATES: ReadonlySet<CallState> = new Set([
  "CONNECTING",
  "ACTIVE",
  "HOLD",
]);

const ALLOWED_TRANSITIONS: Record<CallState, ReadonlySet<CallState>> = {
  RINGING:    new Set<CallState>(["CONNECTING", "ENDED", "FAILED", "MISSED"]),
  // CONNECTING → MISSED covers the outbound-decline case: customer leg ends
  // with no-answer/busy/canceled BEFORE either party reaches ACTIVE.
  CONNECTING: new Set<CallState>(["ACTIVE", "ENDED", "FAILED", "MISSED"]),
  ACTIVE:     new Set<CallState>(["HOLD", "ENDED", "FAILED"]),
  HOLD:       new Set<CallState>(["ACTIVE", "ENDED", "FAILED"]),
  ENDED:      new Set<CallState>(),
  FAILED:     new Set<CallState>(),
  MISSED:     new Set<CallState>(),
};

export class InvalidTransitionError extends Error {
  constructor(public readonly from: CallState, public readonly to: CallState) {
    super(`Invalid call state transition: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function canTransition(from: CallState, to: CallState): boolean {
  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
}

export function assertTransition(from: CallState, to: CallState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** Translate FSM state to the legacy `status` string column. */
export function toLegacyStatus(state: CallState): LegacyCallStatus {
  switch (state) {
    case "RINGING":    return "ringing";
    case "CONNECTING": return "in-progress";
    case "ACTIVE":     return "in-progress";
    case "HOLD":       return "in-progress";
    case "ENDED":      return "completed";
    case "FAILED":     return "failed";
    case "MISSED":     return "no-answer";
  }
}

/**
 * Best-effort reverse mapping — used only when reading legacy rows that
 * pre-date the FSM column. Lossy (in-progress could be CONNECTING/ACTIVE/HOLD;
 * we default to ACTIVE which is the common case).
 */
export function fromLegacyStatus(status: string): CallState {
  switch (status) {
    case "ringing":     return "RINGING";
    case "in-progress": return "ACTIVE";
    case "completed":   return "ENDED";
    case "failed":      return "FAILED";
    case "no-answer":   return "MISSED";
    default:            return "ENDED"; // safest fallback for unknown legacy values
  }
}

export interface StateHistoryEntry {
  state: CallState;
  at: string; // ISO 8601 UTC
  reason?: string;
}

export function makeHistoryEntry(state: CallState, reason?: string, at: Date = new Date()): StateHistoryEntry {
  return reason !== undefined
    ? { state, at: at.toISOString(), reason }
    : { state, at: at.toISOString() };
}

export function appendHistory(history: unknown, state: CallState, reason?: string): StateHistoryEntry[] {
  const arr = Array.isArray(history) ? (history as StateHistoryEntry[]) : [];
  return [...arr, makeHistoryEntry(state, reason)];
}
