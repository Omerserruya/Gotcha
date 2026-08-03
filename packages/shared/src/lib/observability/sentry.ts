/**
 * Sentry for every backend process, wired to FOUR projects and no more.
 *
 * One project per microservice is the obvious design and the wrong one: eleven
 * projects means eleven alert configs, eleven quota limits, and an incident
 * spread across six dashboards. These four are grouped by how someone responds
 * to them, not by how the code is packaged:
 *
 *   gotcha-core-backend      a user is waiting on this request, right now
 *   gotcha-workers-webhooks  nobody is waiting; it will retry; watch the rate
 *   gotcha-voice             a live call is degrading - seconds matter
 *   gotcha-frontend          (browser; see the Next.js side)
 *
 * The `service` tag keeps the individual service identifiable inside its
 * project, so grouping stays coarse while attribution stays exact.
 */
import type { ScrubbableEvent } from "./sentry-scrub";
import { scrubEvent } from "./sentry-scrub";

export type SentryProject = "core-backend" | "workers-webhooks" | "voice";

/**
 * Which project each service reports to.
 *
 * Exported as data so a test can assert every service in the repo appears
 * exactly once. A service missing from this table gets no Sentry at all, which
 * is the failure mode that stays invisible until the incident it would have
 * caught.
 */
export const SERVICE_PROJECT: Record<string, SentryProject> = {
  // Synchronous request/response paths a user is blocked on.
  auth: "core-backend",
  ai: "core-backend",
  conversation: "core-backend",
  billing: "core-backend",
  // analytics and chatbot are synchronous API services too - they answer a
  // request while someone waits - so they belong with the interactive tier
  // rather than with the retrying background one.
  analytics: "core-backend",
  chatbot: "core-backend",

  // Nobody is waiting on these. They retry, they run on a schedule, and a
  // single failure matters far less than a change in failure RATE.
  webhook: "workers-webhooks",
  "incoming-worker": "workers-webhooks",
  "outgoing-worker": "workers-webhooks",
  notifications: "workers-webhooks",

  // A live call cannot be retried. Its own project so its alerting can be
  // louder than everything else without drowning the rest in noise.
  "voice-copilot": "voice",
};

const DSN_ENV: Record<SentryProject, string> = {
  "core-backend": "SENTRY_CORE_BACKEND_DSN",
  "workers-webhooks": "SENTRY_WORKERS_DSN",
  voice: "SENTRY_VOICE_DSN",
};

/** Resolve the DSN for a service, or "" when it is not configured. */
export function resolveDsn(serviceName: string, env: NodeJS.ProcessEnv = process.env): string {
  const project = SERVICE_PROJECT[serviceName];
  if (!project) return "";
  return (env[DSN_ENV[project]] ?? "").trim();
}

export interface SentryInitResult {
  enabled: boolean;
  project: SentryProject | null;
  reason?: string;
}

/**
 * Sentry is PRODUCTION ONLY, and this is the gate that makes that true.
 *
 * Both conditions are required, and neither is redundant:
 *
 *   NODE_ENV=production          the process really is a production build
 *   SENTRY_ENVIRONMENT=production an operator deliberately said so
 *
 * NODE_ENV alone is not enough - staging and CI legitimately run production
 * builds, and a staging stack that inherits a production DSN pollutes the same
 * issue stream the on-call rotation is paging on. SENTRY_ENVIRONMENT alone is
 * not enough either: it is a plain string anyone can set in a local .env.
 *
 * Requiring both means an accidental event needs two independent mistakes.
 * Every non-production caller gets a silent no-op, so no test, CI job or
 * developer machine can emit an event even with a real DSN in the environment.
 */
export function isProductionSentry(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "production" && env.SENTRY_ENVIRONMENT === "production";
}

let initialised = false;

/**
 * Initialise Sentry for this process.
 *
 * Silent no-op outside production, and silent no-op without a DSN. Those are
 * the normal states in development and in tests, and an observability tool must
 * never be the reason a service fails to boot - it reports problems, it does
 * not create them. Every failure path here is caught for the same reason.
 *
 * Safe to call twice; the second call is ignored.
 */
export function initSentry(serviceName: string, env: NodeJS.ProcessEnv = process.env): SentryInitResult {
  if (initialised) return { enabled: true, project: SERVICE_PROJECT[serviceName] ?? null, reason: "already_initialised" };

  const project = SERVICE_PROJECT[serviceName] ?? null;
  if (!project) return { enabled: false, project: null, reason: "service_not_mapped" };

  // FIRST gate, before the DSN is even read. A real DSN present in a test or CI
  // environment must still send nothing, so the environment check cannot come
  // second - see isProductionSentry.
  if (!isProductionSentry(env)) return { enabled: false, project, reason: "not_production" };

  const dsn = resolveDsn(serviceName, env);
  if (!dsn) return { enabled: false, project, reason: "no_dsn" };

  try {
    // Required lazily so services without a DSN never load the SDK, and so a
    // missing optional dependency cannot break a boot.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Sentry = require("@sentry/node");

    Sentry.init({
      dsn,
      // Not a fallback chain - isProductionSentry above already proved this
      // is "production". A default of NODE_ENV here would be a second, softer
      // definition of the same thing, and the two would drift.
      environment: "production",
      release: env.SENTRY_RELEASE || env.BUILD_SHA || undefined,

      // NEVER true. Sentry's "default PII" includes request bodies, cookies and
      // IP addresses - precisely the customer data this system exists to keep.
      sendDefaultPii: false,

      // Sampled, not off: traces are useful and unsampled tracing on a webhook
      // tier is a quota incident. Override per environment.
      tracesSampleRate: Number(env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),

      // The last gate before anything leaves the process.
      beforeSend(event: ScrubbableEvent) {
        try {
          return scrubEvent(event);
        } catch {
          // If scrubbing itself fails we send NOTHING. An unscrubbed event is
          // worse than a missing one.
          return null;
        }
      },
      beforeBreadcrumb(breadcrumb: Record<string, unknown> | null) {
        if (!breadcrumb) return null;
        try {
          // Console breadcrumbs capture whatever was logged, which in this repo
          // includes provider payloads. The category is kept, the content is not.
          if (breadcrumb.category === "console") {
            return { ...breadcrumb, message: undefined, data: undefined };
          }
          return scrubEvent(breadcrumb as ScrubbableEvent) as Record<string, unknown>;
        } catch {
          return null;
        }
      },
    });

    Sentry.setTag("service", serviceName);
    Sentry.setTag("sentry_project", `gotcha-${project}`);

    initialised = true;
    return { enabled: true, project };
  } catch (err) {
    console.warn(`[sentry] init skipped for ${serviceName}: ${(err as Error)?.message ?? err}`);
    return { enabled: false, project, reason: "init_failed" };
  }
}

/**
 * Report an error that is not already flowing through an Express handler -
 * a queue job, a scheduled tick, a WebSocket frame.
 *
 * `tags` are for low-cardinality routing (tenant tier, job name). Do not put a
 * message, a phone number or a token in here; scrubEvent will redact what it
 * recognises, but the cheapest way not to leak something is not to send it.
 */
export function captureError(err: unknown, tags: Record<string, string> = {}): void {
  // `initialised` can only be true in production (initSentry gates on it), so
  // this is belt-and-braces - but it is the function most likely to be called
  // from a test that stubbed something else.
  if (!initialised || !isProductionSentry()) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Sentry = require("@sentry/node");
    Sentry.withScope((scope: { setTag: (k: string, v: string) => void }) => {
      for (const [k, v] of Object.entries(tags)) scope.setTag(k, String(v));
      Sentry.captureException(err);
    });
  } catch {
    /* observability must never throw into the caller */
  }
}

/** Flush pending events before a process exits. Returns whether it drained. */
export async function flushSentry(timeoutMs = 2000): Promise<boolean> {
  if (!initialised) return true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Sentry = require("@sentry/node");
    return await Sentry.flush(timeoutMs);
  } catch {
    return false;
  }
}

/** Test seam: forget that init happened. */
export function __resetSentryForTests(): void {
  initialised = false;
}
