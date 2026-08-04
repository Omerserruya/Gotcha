/**
 * Shopify scope normalization and fail-closed capability status.
 *
 * Two things here, both learned from reading a live grant rather than from
 * the docs.
 *
 * ── 1. Shopify's grant response is COLLAPSED ──
 *
 * `GET /admin/oauth/access_scopes.json` does not echo the scope list that was
 * requested. When `write_orders` is granted it returns `write_orders` and
 * omits `read_orders` entirely, because write implies read. A live read of
 * the demo store returned 19 handles for a 26-scope grant; the 7 absent ones
 * were all implied reads.
 *
 * Storing that response verbatim and then asking `granted.includes("read_orders")`
 * answers FALSE for a store that can absolutely read orders. Both callers got
 * this wrong: the connection test reported healthy connections as "missing
 * scope(s): read_orders, read_customers, read_returns, read_price_rules", and
 * the commerce panel would have hidden read capabilities that work.
 *
 * ── 2. "We never asked" is not "we were granted" ──
 *
 * `config.grantedScopes` was null on every installation in both databases,
 * and the previous gate read `granted.length === 0` as permission for
 * everything. That is backwards: an unverified connection is UNKNOWN, and an
 * action whose authority is unknown must not be offered. This module makes
 * that distinction explicit so the UI can say "verification required" rather
 * than either lying or silently disabling.
 */

/** Every Shopify scope prefix where `write_X` also confers `read_X`. */
const WRITE_PREFIX = "write_";
const READ_PREFIX = "read_";

/**
 * Expand a granted list into every scope it effectively confers.
 *
 * `write_orders` → `write_orders` + `read_orders`. Idempotent, so it is safe
 * to run over an already-expanded list (e.g. one we stored ourselves).
 */
export function expandImpliedScopes(granted: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of granted) {
    const s = String(raw || "").trim();
    if (!s) continue;
    out.add(s);
    if (s.startsWith(WRITE_PREFIX)) out.add(READ_PREFIX + s.slice(WRITE_PREFIX.length));
  }
  return out;
}

/**
 * Normalize a raw Shopify grant response into a sorted, expanded list safe to
 * persist and to compare against required scopes.
 */
export function normalizeGrantedScopes(granted: readonly string[]): string[] {
  return [...expandImpliedScopes(granted)].sort();
}

export type ScopeVerification = "verified" | "unknown";

export interface ScopeState {
  /**
   * `unknown` means we have never successfully read this store's grant.
   * It is NOT a synonym for "empty" and NOT a synonym for "granted".
   */
  verification: ScopeVerification;
  /** Effective scopes (implied reads expanded). Empty when unknown. */
  effective: Set<string>;
}

/**
 * Read scope state off a `TenantIntegration.config` blob.
 *
 * Absent, non-array or empty `grantedScopes` all resolve to `unknown`. A
 * store that genuinely granted nothing cannot exist - Shopify will not
 * complete an install with an empty scope set - so an empty array is
 * evidence the probe never ran, not evidence of a zero grant.
 */
export function readScopeState(config: unknown): ScopeState {
  const raw = (config as { grantedScopes?: unknown } | null)?.grantedScopes;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { verification: "unknown", effective: new Set() };
  }
  return { verification: "verified", effective: expandImpliedScopes(raw as string[]) };
}

/**
 * Fail-closed scope check.
 *
 * Returns true ONLY when the grant was actually read and contains the scope.
 * Unknown returns false, which is the whole point: a capability whose
 * authority we cannot prove must not be exercised or advertised.
 */
export function hasScope(state: ScopeState, scope: string): boolean {
  return state.verification === "verified" && state.effective.has(scope);
}

/** Which of `required` are not provably granted. Everything, when unknown. */
export function missingScopes(state: ScopeState, required: readonly string[]): string[] {
  if (state.verification === "unknown") return [...required];
  return required.filter((s) => !state.effective.has(s));
}
