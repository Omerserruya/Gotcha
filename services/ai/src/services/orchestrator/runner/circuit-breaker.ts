/**
 * Per-key circuit breaker.
 *
 * Lifted from the dead voice-copilot Dispatcher's tenant-level breaker.
 * Generalized to "key" so callers can scope per tool, per tenant, or per
 * tenant×tool. The orchestrator scopes per `${tenantId}:${tool}` so a
 * misbehaving tool doesn't trip every other tool for the same tenant.
 *
 * State machine:
 *   closed  → all calls allowed; failures counted in a sliding window
 *   open    → all calls fast-fail; transitions to half-open after cooldown
 *   half-open → next call is a probe; success → closed, failure → open
 */

export interface CircuitBreakerOptions {
  /** Open the circuit when failures within the window exceed this. */
  failureThreshold?: number;
  /** Sliding-window size in ms for failure counting. */
  windowMs?: number;
  /** Cooldown before half-open transition. */
  cooldownMs?: number;
}

interface BreakerState {
  state: "closed" | "open" | "half-open";
  failures: number[]; // timestamps
  openedAt: number;
}

export class CircuitBreakers {
  private readonly map = new Map<string, BreakerState>();
  private readonly failureThreshold: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;

  constructor(opts?: CircuitBreakerOptions) {
    this.failureThreshold = opts?.failureThreshold ?? 5;
    this.windowMs = opts?.windowMs ?? 60_000;
    this.cooldownMs = opts?.cooldownMs ?? 30_000;
  }

  isOpen(key: string): boolean {
    const s = this.get(key);
    if (s.state === "closed") return false;
    if (s.state === "open") {
      const elapsed = Date.now() - s.openedAt;
      if (elapsed >= this.cooldownMs) {
        s.state = "half-open";
        return false;
      }
      return true;
    }
    return false; // half-open lets a probe through
  }

  recordSuccess(key: string): void {
    const s = this.get(key);
    s.failures = [];
    s.state = "closed";
  }

  recordFailure(key: string): void {
    const s = this.get(key);
    const now = Date.now();
    s.failures = [...s.failures.filter((t) => now - t < this.windowMs), now];
    if (s.state === "half-open") {
      s.state = "open";
      s.openedAt = now;
      return;
    }
    if (s.failures.length >= this.failureThreshold) {
      s.state = "open";
      s.openedAt = now;
    }
  }

  /** Force-reset for testing. */
  reset(key?: string): void {
    if (key) this.map.delete(key);
    else this.map.clear();
  }

  private get(key: string): BreakerState {
    let s = this.map.get(key);
    if (!s) {
      s = { state: "closed", failures: [], openedAt: 0 };
      this.map.set(key, s);
    }
    return s;
  }
}
