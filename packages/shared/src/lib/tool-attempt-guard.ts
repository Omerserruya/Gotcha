/**
 * Stop the model retrying a call that cannot work.
 *
 * On 2026-07-31 Maya called `shopify.update_order_fulfillment` four times in
 * five minutes for one order. Every attempt failed the same way - the order
 * identifier was in the wrong namespace, so Shopify answered 400, 400, 400,
 * 404. Between attempts she told the customer she was contacting the shipping
 * team. Twenty minutes later he asked to cancel the order.
 *
 * The underlying defect is fixed (see shopify-order-identifier.ts). This is the
 * backstop for the next one: a tool that fails the same way twice on the same
 * target is not going to succeed on the third try, and the turns spent
 * discovering that are spent in front of a waiting customer.
 *
 * ── Scope, honestly ─────────────────────────────────────────────────────────
 * In-memory and per-process. A conversation handled by two workers could get
 * one extra attempt per worker, and a restart clears the history. That is
 * acceptable for what this is - a brake on a runaway loop, not an idempotency
 * mechanism. Real once-only execution is the ledger's job, and it already
 * exists. Making this durable would mean a database round trip before every
 * tool call, which costs more than the problem.
 */

/** How many times the same call may fail the same way before it is refused. */
const MAX_IDENTICAL_FAILURES = 2;

/** Conversations tracked at once. Bounded so a long-lived worker cannot grow forever. */
const MAX_TRACKED_CONVERSATIONS = 500;

/** How long a conversation's attempt history stays interesting. */
const TTL_MS = 30 * 60 * 1000;

interface AttemptRecord {
  failures: number;
  lastAt: number;
  lastReason: string;
}

interface ConversationHistory {
  attempts: Map<string, AttemptRecord>;
  touchedAt: number;
}

const HISTORY = new Map<string, ConversationHistory>();

/**
 * Group an error into a CLASS, so cosmetically different messages describing
 * the same problem still count as a repeat.
 *
 * The four production failures were three `shopify_400: id: expected String to
 * be a id` and one `shopify_404: Not Found`. Those are two messages and one
 * problem: the identifier does not resolve.
 */
export function failureClass(reason: unknown): string {
  const s = String(reason ?? "").toLowerCase();
  if (!s) return "unknown";
  if (/\b40[034]\b|not[_ ]found|expected string to be a id|order_not_found|order_identifier_invalid/.test(s)) {
    return "target_not_resolvable";
  }
  if (/\b401\b|\b403\b|unauthor|forbidden|scope|permission/.test(s)) return "not_permitted";
  if (/\b429\b|rate limit|throttl/.test(s)) return "rate_limited";
  if (/\b5\d{2}\b|timeout|econnreset|unavailable/.test(s)) return "provider_unavailable";
  if (/required|invalid|missing/.test(s)) return "bad_arguments";
  return "other";
}

/**
 * A stable key for "the same call again".
 *
 * Built from the arguments that identify the TARGET, not the whole payload -
 * the model varied its `note` and `tag` text on every retry while pointing at
 * the same order, and a whole-payload hash would have called those four
 * different calls.
 */
export function attemptKey(toolName: string, args: Record<string, unknown>): string {
  const norm = (v: unknown) => String(v ?? "").trim().replace(/^#/, "").toLowerCase();
  const target = [
    norm(args?.order_name) || norm(args?.order_id),
    norm(args?.customer_id) || norm(args?.email) || norm(args?.phone),
    norm(args?.product_id),
    norm(args?.id),
  ].filter(Boolean).join("|");
  return `${toolName}::${target || "no-target"}`;
}

function historyFor(conversationId: string): ConversationHistory {
  const now = Date.now();

  // Opportunistic eviction - cheaper than a timer, and this map is small.
  if (HISTORY.size > MAX_TRACKED_CONVERSATIONS) {
    for (const [id, h] of HISTORY) {
      if (now - h.touchedAt > TTL_MS) HISTORY.delete(id);
    }
    if (HISTORY.size > MAX_TRACKED_CONVERSATIONS) {
      const oldest = [...HISTORY.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
      if (oldest) HISTORY.delete(oldest[0]);
    }
  }

  let h = HISTORY.get(conversationId);
  if (!h || now - h.touchedAt > TTL_MS) {
    h = { attempts: new Map(), touchedAt: now };
    HISTORY.set(conversationId, h);
  }
  h.touchedAt = now;
  return h;
}

export interface AttemptVerdict {
  /** False when this call has already failed the same way too often. */
  allowed: boolean;
  failures: number;
  /** Model-facing explanation. Never shown to the customer. */
  reason?: string;
}

/** Should this call be attempted, or has it already proved it cannot work? */
export function checkToolAttempt(
  conversationId: string | undefined,
  toolName: string,
  args: Record<string, unknown>,
): AttemptVerdict {
  if (!conversationId) return { allowed: true, failures: 0 };
  const rec = historyFor(conversationId).attempts.get(attemptKey(toolName, args));
  if (!rec || rec.failures < MAX_IDENTICAL_FAILURES) {
    return { allowed: true, failures: rec?.failures ?? 0 };
  }
  return {
    allowed: false,
    failures: rec.failures,
    reason:
      `${toolName} has already failed ${rec.failures} times for this target with the same problem ` +
      `(${rec.lastReason}). Do not call it again. Either use a different approach, tell the ` +
      `customer plainly what you could not do, or hand over to a human. Do NOT claim this ` +
      `action succeeded or that anyone was contacted.`,
  };
}

/** Record the outcome of a call so the next identical one can be refused. */
export function recordToolAttempt(
  conversationId: string | undefined,
  toolName: string,
  args: Record<string, unknown>,
  outcome: { ok: boolean; reason?: unknown },
): void {
  if (!conversationId) return;
  const h = historyFor(conversationId);
  const key = attemptKey(toolName, args);

  if (outcome.ok) {
    // Success clears the history for this target: whatever was wrong is not
    // wrong any more, and a later unrelated failure deserves its own budget.
    h.attempts.delete(key);
    return;
  }

  const cls = failureClass(outcome.reason);
  const prev = h.attempts.get(key);
  // A DIFFERENT failure class is a different problem and starts its own count -
  // otherwise fixing one error would leave the call blocked by the tally from
  // the previous one.
  const failures = prev && prev.lastReason === cls ? prev.failures + 1 : 1;
  h.attempts.set(key, { failures, lastAt: Date.now(), lastReason: cls });
}

/** Test-only: forget everything. */
export function __resetToolAttemptGuard(): void {
  HISTORY.clear();
}
