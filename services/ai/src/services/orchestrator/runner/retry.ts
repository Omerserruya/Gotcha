/**
 * Exponential-backoff retry helper.
 *
 * Lifted from the dead `services/voice-copilot/src/dispatch/dispatcher.ts`
 * (deleted in Phase 4). Schedule was [250, 500, 1000, 2000, 4000] ms - kept
 * here verbatim so the proven semantics carry forward.
 */

export const DEFAULT_BACKOFF_SCHEDULE_MS: ReadonlyArray<number> = [
  250, 500, 1000, 2000, 4000,
] as const;

export interface RetryOptions {
  /** Per-attempt delays in ms. attempts = schedule.length + 1 (the immediate first attempt). */
  scheduleMs?: ReadonlyArray<number>;
  /** Predicate: should we retry on this error? Defaults to "retry everything". */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** Per-attempt timeout. 0 disables. */
  perAttemptTimeoutMs?: number;
}

export interface RetryOutcome<T> {
  ok: true;
  result: T;
  attempts: number;
}

export interface RetryFailure {
  ok: false;
  error: unknown;
  attempts: number;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions,
): Promise<RetryOutcome<T> | RetryFailure> {
  const schedule = opts?.scheduleMs ?? DEFAULT_BACKOFF_SCHEDULE_MS;
  const shouldRetry = opts?.shouldRetry ?? (() => true);
  const perAttemptTimeoutMs = opts?.perAttemptTimeoutMs ?? 0;

  let lastErr: unknown;
  const totalAttempts = schedule.length + 1;
  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      const result = await runWithTimeout(fn, perAttemptTimeoutMs);
      return { ok: true, result, attempts: attempt };
    } catch (err) {
      lastErr = err;
      if (attempt === totalAttempts) break;
      if (!shouldRetry(err, attempt)) break;
      const delay = schedule[attempt - 1];
      await sleep(delay);
    }
  }
  return { ok: false, error: lastErr, attempts: totalAttempts };
}

async function runWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  if (timeoutMs <= 0) return fn();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`tool execution timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    fn().then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
