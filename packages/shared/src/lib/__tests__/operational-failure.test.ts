/**
 * The one entry point every emitter uses, and the guarantees the alert rules
 * depend on.
 *
 * Alerts filter on tags. If a call site can produce a different tag shape, the
 * rule silently stops matching and the channel stays quiet through the incident
 * it was written for. So the tag builder is pure and asserted directly.
 *
 * The second half is the part with real consequences: an operational report
 * must not become the thing that leaks a prompt, a customer message or a token
 * into a third-party dashboard.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  buildFailureTags, projectFor, assertSafeContext, UnsafeContextError,
  reportOperationalFailure, recordExpectedOutcome,
} from "../observability/operational-failure";
import { ERROR_CODES } from "../observability/error-codes";

const base = {
  errorCode: ERROR_CODES.ai_provider_failure,
  domain: "ai" as const,
  service: "ai",
};

afterEach(() => { delete process.env.NODE_ENV_OVERRIDE; });

describe("tags an alert can filter on", () => {
  it("always carries error_code, domain and service", () => {
    expect(buildFailureTags(base)).toEqual({ error_code: "ai_provider_failure", domain: "ai", service: "ai" });
  });

  it("adds provider only when there is one", () => {
    expect(buildFailureTags({ ...base, provider: "openai" }).provider).toBe("openai");
    expect(buildFailureTags(base).provider).toBeUndefined();
  });

  it.each([
    ["ai", "core-backend"],
    ["conversation", "core-backend"],
    ["billing", "core-backend"],
    ["webhook", "workers-webhooks"],
    ["incoming-worker", "workers-webhooks"],
    ["notifications", "workers-webhooks"],
    ["voice-copilot", "voice"],
  ])("routes %s to the %s project", (service, project) => {
    expect(projectFor(service)).toBe(project);
  });

  it("returns no project for an unmapped service", () => {
    expect(projectFor("not-a-service")).toBeNull();
  });
});

describe("context safety", () => {
  it("allows operational, low-cardinality context", () => {
    const ctx = { attempts: 3, status: 502, retryable: true, tool: "shopify.order.refund", stage: "callback" };
    expect(assertSafeContext(ctx)).toEqual(ctx);
  });

  /**
   * By NAME, not by value. scrubValue would redact most of these on the way
   * out, but a redacted value still means the call site tried - and the next
   * field someone invents may not match a pattern. Failing here is how that is
   * caught before it reaches production.
   */
  it.each([
    "accessToken", "refresh_token", "apiKey", "client_secret", "password",
    "prompt", "completion", "messageBody", "body", "transcript",
    "email", "phone", "phoneNumber", "e164", "address",
    "authorization", "cookie", "signature", "dsn",
  ])("refuses %s in development", (key) => {
    expect(() => assertSafeContext({ [key]: "value" }, { NODE_ENV: "test" } as NodeJS.ProcessEnv))
      .toThrow(UnsafeContextError);
  });

  /**
   * In production it drops them instead of throwing. Telemetry must never be
   * the reason a request fails - especially in a path that is already failing.
   */
  it("drops unsafe keys in production rather than throwing", () => {
    const out = assertSafeContext(
      { accessToken: "secret", attempts: 2 },
      { NODE_ENV: "production" } as NodeJS.ProcessEnv,
    );
    expect(out).toEqual({ attempts: 2 });
  });

  it("passes undefined through", () => {
    expect(assertSafeContext(undefined)).toBeUndefined();
  });
});

describe("never sends outside production", () => {
  /**
   * The suite runs with NODE_ENV=test, so both of these are no-ops. They must
   * also not throw - a caller in a failing path cannot afford a second failure.
   */
  it("reportOperationalFailure is inert and silent", () => {
    expect(() => reportOperationalFailure({ ...base, cause: new Error("boom"), context: { attempts: 1 } }))
      .not.toThrow();
  });

  it("recordExpectedOutcome is inert and silent", () => {
    expect(() => recordExpectedOutcome("user_cancelled_oauth", { provider: "google" })).not.toThrow();
  });

  /**
   * The developer-mistake path still surfaces, because a silent no-op there
   * would let an unsafe call site ship unnoticed.
   */
  it("still rejects unsafe context loudly in a test environment", () => {
    expect(() => reportOperationalFailure({ ...base, context: { accessToken: "leak" } }))
      .toThrow(UnsafeContextError);
    expect(() => recordExpectedOutcome("x", { prompt: "leak" })).toThrow(UnsafeContextError);
  });
});
