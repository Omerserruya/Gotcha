/**
 * In-process AbortController registry for per-conversation AI turns.
 *
 * Why: a customer who fires three messages in quick succession should not
 * burn three full LLM rounds — the older replies are obsolete the moment a
 * newer message arrives. `beginTurn(key)` aborts any in-flight controller
 * for the same key before handing back a fresh signal, so the older LLM
 * fetch is cancelled at the SDK layer (saves tokens + latency) and the
 * caller returns early via the AbortError branch.
 *
 * Scope: lives in the AI service process — the entry points
 * (/api/ai-bot/reply, voice-assist triggerAssist) all run here, so a single
 * in-memory map is the correct authority. The incoming-worker holds no
 * controllers; if a newer worker job arrives while an older one is still
 * blocked on axios.post, the SECOND request's beginTurn() inside this
 * service aborts the first, the first's axios.post resolves with a 499,
 * and the worker treats it as a silent no-op.
 */
export type TurnKind = "bot" | "copilot";

const inflight = new Map<string, AbortController>();

function makeKey(tenantId: string, conversationId: string, kind: TurnKind): string {
  return `${kind}:${tenantId}:${conversationId}`;
}

export interface TurnHandle {
  signal: AbortSignal;
  /** Release this turn's slot. Idempotent. Call in `finally`. */
  end: () => void;
}

/**
 * Reserve a turn slot for (tenant, conversation, kind). Any previously
 * in-flight controller for the same key is aborted with reason
 * "superseded-by-newer-turn" before the new one is installed.
 */
export function beginTurn(tenantId: string, conversationId: string, kind: TurnKind): TurnHandle {
  const key = makeKey(tenantId, conversationId, kind);
  const existing = inflight.get(key);
  if (existing && !existing.signal.aborted) {
    existing.abort(new Error("superseded-by-newer-turn"));
  }
  const ctrl = new AbortController();
  inflight.set(key, ctrl);

  let released = false;
  return {
    signal: ctrl.signal,
    end: () => {
      if (released) return;
      released = true;
      // Only clear if it's still our controller — a newer turn may have
      // already replaced us, in which case we leave that one alone.
      if (inflight.get(key) === ctrl) inflight.delete(key);
    },
  };
}

/**
 * True for both DOM AbortError instances and the OpenAI SDK's wrapper
 * ("APIUserAbortError"). Used by callers to distinguish "we got cancelled,
 * stay quiet" from real errors that need to surface.
 */
export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; code?: string; message?: string };
  if (e.name === "AbortError" || e.name === "APIUserAbortError") return true;
  if (e.code === "ABORT_ERR") return true;
  return typeof e.message === "string" && /aborted|superseded-by-newer-turn/i.test(e.message);
}
