/**
 * Browser Sentry for gotcha-frontend. Production only.
 *
 * The production frontend is a STATIC EXPORT (`output: export`, served by nginx
 * from the gateway image). Two consequences that shape everything here:
 *
 *   1. There is no Next.js server in production, so server-side instrumentation
 *      would be dead code. This file is the whole integration.
 *   2. Nothing is read from the environment at runtime. Every value below is
 *      frozen into the bundle at build time, which is why they are NEXT_PUBLIC_
 *      and why changing one requires a gateway rebuild, not an .env edit.
 *
 * A Sentry DSN is not a secret - it is designed to sit in a public bundle and
 * only grants the ability to POST events. It is still gated the same way as the
 * backend so that a bundle built by mistake outside a production release cannot
 * report into the on-call stream.
 */

/**
 * True only for a real production bundle.
 *
 * Both halves are required, exactly as on the backend: `NODE_ENV` proves this
 * is a production build (Next sets it), and the explicit environment string
 * proves an operator asked for it. A `next dev` session, a `next build` run by
 * a developer, a CI type-check - none of them satisfy both.
 */
export function isProductionSentryClient(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): boolean {
  return env.NODE_ENV === "production" && env.NEXT_PUBLIC_SENTRY_ENVIRONMENT === "production";
}

/**
 * Strip anything that could carry a credential or a customer's words.
 *
 * The browser sees less than the backend, but not nothing: URLs carry OAuth
 * `code` and `state` on the integration callback screens, and breadcrumbs
 * capture fetch URLs and console output from the AI Assistant and HITL panels.
 */
const TOKEN_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{10,}=*/gi,
  /\beyJ[A-Za-z0-9._-]{20,}/g,
];

export function redactClient(input: string): string {
  let out = input;
  for (const re of TOKEN_PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}

/** Keep the path, drop the query - that is where `code` and `state` live. */
export function stripQuery(url: string | undefined): string | undefined {
  if (!url) return url;
  const q = url.indexOf("?");
  const h = url.indexOf("#");
  const cut = Math.min(...[q, h].filter((i) => i >= 0), url.length);
  return redactClient(url.slice(0, cut)) + (cut < url.length ? "?[stripped]" : "");
}

/** Event shape this touches; mirrors the backend scrubber. */
export interface ClientEvent {
  request?: { url?: string; query_string?: unknown; data?: unknown; headers?: Record<string, unknown> };
  message?: string;
  user?: Record<string, unknown>;
  exception?: { values?: Array<{ value?: string }> };
  breadcrumbs?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

export function scrubClientEvent(event: ClientEvent): ClientEvent {
  if (event.request) {
    event.request.url = stripQuery(event.request.url);
    delete event.request.data;    // form state, message drafts
    delete event.request.headers;
    event.request.query_string = undefined;
  }
  if (event.message) event.message = redactClient(event.message);
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = redactClient(ex.value);
  }
  // Identify the account, never the person: no email, no name, no IP.
  if (event.user) {
    const id = event.user.id;
    event.user = id === undefined ? {} : { id: String(id) };
  }
  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs.map((b) => {
      const next: Record<string, unknown> = { ...b };
      // Console breadcrumbs quote whatever was logged, including API responses.
      if (next.category === "console") { delete next.message; delete next.data; }
      if (typeof next.message === "string") next.message = redactClient(next.message);
      const d = next.data as Record<string, unknown> | undefined;
      if (d && typeof d.url === "string") next.data = { ...d, url: stripQuery(d.url) };
      return next;
    });
  }
  return event;
}

/** The options object, exported so a test can assert the guarantees. */
export function sentryClientOptions(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
) {
  return {
    dsn: env.NEXT_PUBLIC_SENTRY_DSN,
    environment: "production",
    release: env.NEXT_PUBLIC_SENTRY_RELEASE || undefined,
    sendDefaultPii: false,
    tracesSampleRate: Number(env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
    // Session Replay is deliberately OFF. It records the DOM, which on this
    // product means customer conversations, phone numbers and billing details.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    beforeSend(event: ClientEvent) {
      try { return scrubClientEvent(event); } catch { return null; }
    },
  };
}
