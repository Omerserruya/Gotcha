/**
 * Staged-rollout feature flags for the BFF cookie-session migration
 * (docs/security/bff-session-migration-map.md §A15).
 *
 * INVARIANT: every NEW behavior defaults to disabled, and the LEGACY behaviors
 * default to their current values, so a deployment that sets none of these
 * flags authenticates EXACTLY as it does today. Commit 1 only reads these; no
 * code path acts on them yet.
 */

export interface SessionFlags {
  /** Issue a cookie session on login. New behavior - default OFF. */
  cookieCreate: boolean;
  /** Honor a cookie session at the resolver. New behavior - default OFF. */
  cookieAccept: boolean;
  /** Services still accept a browser Bearer token. Legacy - default ON. */
  legacyBearerAccept: boolean;
  /** SPA still stores/sends browser tokens. Legacy - default ON. */
  browserTokenIssue: boolean;
  /** Reject browser Bearer (cookie-only). New behavior - default OFF. */
  cookieOnlyEnforce: boolean;
}

const isTrue = (v: string | undefined) => v === "true" || v === "1";
const isFalse = (v: string | undefined) => v === "false" || v === "0";

export function readSessionFlags(env: NodeJS.ProcessEnv = process.env): SessionFlags {
  return {
    cookieCreate: isTrue(env.SESSION_COOKIE_CREATE), // default false
    cookieAccept: isTrue(env.SESSION_COOKIE_ACCEPT), // default false
    // Legacy defaults ON unless explicitly turned off.
    legacyBearerAccept: !isFalse(env.LEGACY_BEARER_ACCEPT),
    browserTokenIssue: !isFalse(env.BROWSER_TOKEN_ISSUE),
    cookieOnlyEnforce: isTrue(env.COOKIE_ONLY_ENFORCE), // default false
  };
}

/** True once any cookie-session behavior is switched on (gates startup asserts). */
export function sessionInfraEnabled(flags: SessionFlags): boolean {
  return flags.cookieCreate || flags.cookieAccept || flags.cookieOnlyEnforce;
}
