/**
 * One way to report an operational failure, so every alert can rely on the
 * same shape.
 *
 * Alerts filter on tags. If each call site invents its own tag names the rules
 * silently stop matching the moment someone writes `errorCode` instead of
 * `error_code`, and nobody notices until the incident the rule existed to catch.
 * So there is exactly one entry point and the tag vocabulary is typed.
 *
 * Two functions, and the distinction between them matters more than either:
 *
 *   reportOperationalFailure  something went wrong that a human should look at
 *   recordExpectedOutcome     something went "wrong" that is working as designed
 *
 * A user cancelling an OAuth consent screen, a policy correctly denying an
 * action, an optional integration that was never configured - these are not
 * failures. Filing them as Sentry issues is how an alert channel becomes
 * something people mute, and a muted channel is worse than no channel. They
 * become breadcrumbs instead: visible on a real issue, invisible on their own.
 */
import type { ErrorCode } from "./error-codes";
import { SERVICE_PROJECT, type SentryProject } from "./sentry";
import { scrubValue, redactSecrets } from "./sentry-scrub";
import { isProductionSentry } from "./sentry";

/** Coarse area of the product, used for grouping and dashboards. */
export type FailureDomain =
  | "ai" | "hitl" | "integration" | "webhook" | "billing" | "voice" | "security" | "action";

export interface OperationalFailure {
  /** The alerting contract. Never an ad-hoc string. */
  errorCode: ErrorCode;
  domain: FailureDomain;
  /** Which service is reporting; decides the Sentry project. */
  service: string;
  /** Low cardinality only: "shopify", "meta", "google", "twilio", "icount". */
  provider?: string;
  /** The underlying error, if there is one. */
  cause?: unknown;
  /**
   * Extra context. Scrubbed before it leaves, but the cheapest way not to leak
   * something is not to pass it: no tokens, prompts, message bodies, emails or
   * phone numbers. `assertSafeContext` fails loudly in development if you do.
   */
  context?: Record<string, unknown>;
}

/**
 * Context keys that must never be passed, checked by NAME.
 *
 * scrubValue would redact most of these on the way out, but a redacted value
 * still means the call site tried - and the next field it invents may not match
 * a pattern. Failing in development is how that gets caught before production.
 */
const FORBIDDEN_CONTEXT_KEY =
  /(?:token|secret|password|credential|prompt|completion|message|body|transcript|email|phone|e164|address|apikey|api_key|authorization|cookie|dsn|signature)/i;

export class UnsafeContextError extends Error {}

/**
 * Reject obviously unsafe context. Throws only outside production - a telemetry
 * helper must never be the reason a production request fails, so in production
 * the offending keys are dropped instead.
 */
export function assertSafeContext(
  context: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> | undefined {
  if (!context) return context;
  const bad = Object.keys(context).filter((k) => FORBIDDEN_CONTEXT_KEY.test(k));
  if (bad.length === 0) return context;
  if (env.NODE_ENV !== "production") {
    throw new UnsafeContextError(
      `operational failure context must not carry ${bad.join(", ")} - pass an id or a count instead`,
    );
  }
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(context)) if (!FORBIDDEN_CONTEXT_KEY.test(k)) safe[k] = v;
  return safe;
}

/** The exact tag set an alert rule can filter on. Pure, so tests can assert it. */
export function buildFailureTags(f: OperationalFailure): Record<string, string> {
  const tags: Record<string, string> = {
    error_code: f.errorCode,
    domain: f.domain,
    service: f.service,
  };
  if (f.provider) tags.provider = f.provider;
  return tags;
}

/** Which Sentry project this failure lands in. */
export function projectFor(service: string): SentryProject | null {
  return SERVICE_PROJECT[service] ?? null;
}

/**
 * Report a real failure.
 *
 * Never throws. A telemetry call that can break the caller is a liability in
 * exactly the code path that is already failing.
 */
export function reportOperationalFailure(f: OperationalFailure): void {
  try {
    const context = assertSafeContext(f.context);
    if (!isProductionSentry()) return;

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Sentry = require("@sentry/node");
    Sentry.withScope((scope: {
      setTag: (k: string, v: string) => void;
      setContext: (k: string, v: unknown) => void;
      setLevel: (l: string) => void;
    }) => {
      for (const [k, v] of Object.entries(buildFailureTags(f))) scope.setTag(k, v);
      if (context) scope.setContext("operation", scrubValue(context) as Record<string, unknown>);
      scope.setLevel("error");
      if (f.cause instanceof Error) Sentry.captureException(f.cause);
      else Sentry.captureMessage(redactSecrets(`${f.domain}: ${f.errorCode}`));
    });
  } catch (err) {
    // UnsafeContextError is a developer mistake and must surface loudly, but
    // only where it is safe to do so - never in a production request path.
    if (err instanceof UnsafeContextError && process.env.NODE_ENV !== "production") throw err;
  }
}

/**
 * Record something that went "wrong" but is working as designed.
 *
 * A breadcrumb, not an issue. It shows up as context on a real failure that
 * happens later in the same request, and produces nothing on its own.
 */
export function recordExpectedOutcome(
  outcome: string,
  data: Record<string, unknown> = {},
): void {
  try {
    const safe = assertSafeContext(data);
    if (!isProductionSentry()) return;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Sentry = require("@sentry/node");
    Sentry.addBreadcrumb({
      category: "expected_outcome",
      message: outcome,
      level: "info",
      data: safe ? (scrubValue(safe) as Record<string, unknown>) : undefined,
    });
  } catch (err) {
    if (err instanceof UnsafeContextError && process.env.NODE_ENV !== "production") throw err;
  }
}
