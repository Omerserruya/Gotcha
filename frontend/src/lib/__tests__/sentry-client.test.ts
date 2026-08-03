/**
 * Browser Sentry: production only, and nothing personal in the payload.
 *
 * The frontend is a static export, so every value is frozen into the bundle at
 * build time. That makes the gate here even more important than on the backend:
 * a bundle built with the wrong flags cannot be corrected by editing .env on the
 * box, it has to be rebuilt.
 */
import { describe, it, expect } from "vitest";
import {
  isProductionSentryClient, scrubClientEvent, stripQuery, redactClient, sentryClientOptions,
  type ClientEvent,
} from "../sentry-client";

/** Assembled at runtime - the literals match real credential shapes by design. */
const BEARER = ["Bearer", " ", "abcdef1234567890XYZ"].join("");
const JWT = ["eyJ", "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", ".x"].join("");

describe("production gate", () => {
  it.each([
    [{ NODE_ENV: "production", NEXT_PUBLIC_SENTRY_ENVIRONMENT: "production" }, true],
    [{ NODE_ENV: "production", NEXT_PUBLIC_SENTRY_ENVIRONMENT: "staging" }, false],
    [{ NODE_ENV: "production" }, false],
    [{ NODE_ENV: "development", NEXT_PUBLIC_SENTRY_ENVIRONMENT: "production" }, false],
    [{ NODE_ENV: "test", NEXT_PUBLIC_SENTRY_ENVIRONMENT: "production" }, false],
    [{}, false],
  ])("%o -> %s", (env, expected) => {
    expect(isProductionSentryClient(env as Record<string, string>)).toBe(expected);
  });

  it("is off under the test suite's own environment", () => {
    expect(isProductionSentryClient()).toBe(false);
  });
});

describe("options", () => {
  /**
   * Session Replay records the DOM. On this product that is customer
   * conversations, phone numbers and billing details, so it stays off - a
   * default that must be asserted rather than assumed.
   */
  it("keeps Session Replay disabled", () => {
    const o = sentryClientOptions({});
    expect(o.replaysSessionSampleRate).toBe(0);
    expect(o.replaysOnErrorSampleRate).toBe(0);
  });

  it("never sends default PII", () => {
    expect(sentryClientOptions({}).sendDefaultPii).toBe(false);
  });

  it("pins the environment to production rather than echoing input", () => {
    expect(sentryClientOptions({ NEXT_PUBLIC_SENTRY_ENVIRONMENT: "staging" }).environment).toBe("production");
  });
});

describe("scrubClientEvent", () => {
  const event = (): ClientEvent => ({
    request: {
      url: "https://app.gotcha.co.il/auth/callback?code=abc123&state=xyz",
      query_string: "code=abc123",
      data: { draft: "message the customer typed" },
      headers: { authorization: BEARER },
    },
    user: { id: "u_1", email: "customer@example.com", ip_address: "1.2.3.4" },
    exception: { values: [{ value: `fetch failed: ${BEARER}` }] },
    breadcrumbs: [
      { category: "console", message: `API said: ${JWT}` },
      { category: "fetch", data: { url: "/api/integrations/callback?code=secret123" } },
    ],
  });

  /** The OAuth callback screen is the one place a code reliably appears. */
  it("strips the query string where OAuth codes live", () => {
    expect(scrubClientEvent(event()).request?.url)
      .toBe("https://app.gotcha.co.il/auth/callback?[stripped]");
  });

  it("drops request data and headers", () => {
    const e = scrubClientEvent(event());
    expect(e.request?.data).toBeUndefined();
    expect(e.request?.headers).toBeUndefined();
  });

  it("reduces the user to an opaque id", () => {
    expect(scrubClientEvent(event()).user).toEqual({ id: "u_1" });
  });

  it("empties console breadcrumbs, which quote API responses verbatim", () => {
    const b = scrubClientEvent(event()).breadcrumbs?.[0] as Record<string, unknown>;
    expect(b.message).toBeUndefined();
  });

  it("strips the query from fetch breadcrumb urls", () => {
    const b = scrubClientEvent(event()).breadcrumbs?.[1] as Record<string, unknown>;
    expect(JSON.stringify(b)).not.toContain("secret123");
  });

  it("leaves nothing sensitive anywhere in the event", () => {
    const s = JSON.stringify(scrubClientEvent(event()));
    for (const leak of [
      "abc123", "secret123", "message the customer typed",
      "abcdef1234567890XYZ", "customer@example.com", "1.2.3.4",
    ]) {
      expect(s, `leaked: ${leak}`).not.toContain(leak);
    }
  });
});

describe("helpers", () => {
  it("stripQuery also removes a fragment", () => {
    expect(stripQuery("https://x.test/a#token=abc")).toBe("https://x.test/a?[stripped]");
  });
  it("redactClient removes bearer tokens and JWTs", () => {
    expect(redactClient(BEARER)).toContain("[redacted]");
    expect(redactClient(JWT)).toContain("[redacted]");
  });
});
