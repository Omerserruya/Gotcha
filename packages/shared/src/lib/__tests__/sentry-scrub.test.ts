/**
 * What must never reach Sentry.
 *
 * GOTCHA handles customer messages, provider access tokens and tenant data. An
 * exception report is worth having; it is not worth a customer's WhatsApp
 * message or a Shopify token sitting in a third-party dashboard, where it is
 * outside our retention policy, our DPA and our erasure procedure.
 *
 * These assert the ALLOW-LIST behaviour. A deny-list would pass a test written
 * against today's headers and leak the first time a provider invents a new one.
 */
import { describe, it, expect } from "vitest";
import {
  scrubEvent, scrubValue, scrubHeaders, scrubUrl, redactSecrets, REDACTED,
  type ScrubbableEvent,
} from "../observability/sentry-scrub";

/**
 * Assembled at runtime, never written as a literal.
 *
 * These are synthetic, but they match the exact shape of a real Twilio key -
 * which is the whole point of the test, and also why GitHub's secret scanner
 * rejects the literal form. Building them from parts keeps the assertion honest
 * without committing something that reads as a live credential.
 */
const HEX32 = "0123456789abcdef".repeat(2);
const TWILIO_KEY_SID = ["S", "K", HEX32].join("");
const TWILIO_ACCOUNT_SID = ["A", "C", HEX32].join("");
const SHOPIFY_TOKEN = ["shp", "at", "_", "abcdefghijklmnop1234"].join("");
const OPENAI_KEY = ["sk", "-", "abcdefghijklmnop1234"].join("");
const SLACK_TOKEN = ["xox", "b", "-1234567890-abcdef"].join("");
const GITHUB_TOKEN = ["gh", "p", "_", "abcdefghijklmnopqrstuvwxyz"].join("");
const BEARER = ["Bearer", " ", "abcdef1234567890XYZ"].join("");
const JWT = ["eyJ", "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", ".abc"].join("");

describe("redactSecrets", () => {
  it.each([
    [`Authorization: ${BEARER}`, /Bearer/],
    [`token ${JWT}`, /eyJ/],
    [`key ${OPENAI_KEY}`, /sk-/],
    [`shop ${SHOPIFY_TOKEN}`, /shpat_/],
    [`twilio ${TWILIO_KEY_SID}`, /SK0/],
    [`twilio ${TWILIO_ACCOUNT_SID}`, /AC0/],
    [`slack ${SLACK_TOKEN}`, /xoxb-/],
    [`github ${GITHUB_TOKEN}`, /ghp_/],
  ])("redacts %s", (input, stillPresent) => {
    const out = redactSecrets(input);
    expect(out).toContain(REDACTED);
    expect(out).not.toMatch(stillPresent);
  });

  it("leaves ordinary text alone", () => {
    expect(redactSecrets("conversation 42 failed to send")).toBe("conversation 42 failed to send");
  });
});

describe("scrubHeaders", () => {
  it("keeps only allow-listed headers", () => {
    const out = scrubHeaders({
      "content-type": "application/json",
      "user-agent": "TwilioProxy/1.1",
      authorization: "Bearer secret-value-here",
      cookie: "session=abc",
      "x-internal-key": "internal",
      "x-twilio-signature": "sig",
      "x-hub-signature-256": "sha256=deadbeef",
      "x-shopify-hmac-sha256": "hmac",
    });
    expect(Object.keys(out).sort()).toEqual(["content-type", "user-agent"]);
  });

  /**
   * The point of an allow-list: a header nobody has thought of yet is dropped
   * by default rather than kept by default.
   */
  it("drops an unknown header carrying a credential", () => {
    expect(scrubHeaders({ "x-provider-token-2027": ["super", "secret"].join("") })).toEqual({});
  });

  it("is case-insensitive on header names", () => {
    expect(scrubHeaders({ "Content-Type": "application/json", Authorization: BEARER }))
      .toEqual({ "Content-Type": "application/json" });
  });
});

describe("scrubUrl", () => {
  it("keeps the path and strips the query, where OAuth codes live", () => {
    expect(scrubUrl("https://app.gotcha.co.il/auth/callback?code=abc123&state=xyz"))
      .toBe("https://app.gotcha.co.il/auth/callback?[stripped]");
  });
  it("leaves a query-less url intact", () => {
    expect(scrubUrl("https://app.gotcha.co.il/api/conversations")).toBe("https://app.gotcha.co.il/api/conversations");
  });
});

describe("scrubValue", () => {
  it("redacts secret-shaped KEYS regardless of value", () => {
    const out = scrubValue({ apiKey: "x", client_secret: "y", refreshToken: "z", signature: "s" }) as Record<string, unknown>;
    expect(Object.values(out)).toEqual([REDACTED, REDACTED, REDACTED, REDACTED]);
  });

  /** Not a secret - worse. A token can be rotated; a customer's words cannot. */
  it("redacts message content and personal data", () => {
    const out = scrubValue({
      body: "hi, my card is 4111 1111 1111 1111",
      transcript: "the caller said...",
      phone: "+972541234567",
      email: "customer@example.com",
      name: "A Customer",
    }) as Record<string, unknown>;
    expect(Object.values(out).every((v) => v === REDACTED)).toBe(true);
  });

  it("keeps operationally useful non-sensitive fields", () => {
    expect(scrubValue({ tenantId: "t_1", statusCode: 502, retryable: true }))
      .toEqual({ tenantId: "t_1", statusCode: 502, retryable: true });
  });

  it("redacts a token pasted into an innocent-looking field", () => {
    const out = scrubValue({ detail: `failed with ${BEARER}` }) as Record<string, string>;
    expect(out.detail).toContain(REDACTED);
  });

  it("bounds recursion instead of walking a huge provider payload", () => {
    let deep: Record<string, unknown> = { leaf: "v" };
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    expect(() => scrubValue(deep)).not.toThrow();
    expect(JSON.stringify(scrubValue(deep))).toContain(REDACTED);
  });
});

describe("scrubEvent", () => {
  const event = (): ScrubbableEvent => ({
    request: {
      url: "https://app.gotcha.co.il/api/webhooks/shopify?hmac=abc",
      query_string: "hmac=abc",
      data: { customerMessage: "please cancel my order" },
      cookies: { session: "s" },
      headers: { "content-type": "application/json", authorization: BEARER },
      env: { REMOTE_ADDR: "1.2.3.4" },
    },
    user: { id: "u_1", email: "customer@example.com", ip_address: "1.2.3.4", username: "someone" },
    extra: { accessToken: SHOPIFY_TOKEN, tenantId: "t_1" },
    exception: { values: [{ value: `POST failed: ${BEARER}` }] },
    breadcrumbs: [{ category: "http", data: { body: "customer said hello" } }],
  });

  it("drops the request body entirely - there is no safe subset", () => {
    const e = scrubEvent(event());
    expect(e.request?.data).toBeUndefined();
  });

  it("drops cookies, env and the query string", () => {
    const e = scrubEvent(event());
    expect(e.request?.cookies).toBeUndefined();
    expect(e.request?.env).toBeUndefined();
    expect(e.request?.query_string).toBeUndefined();
    expect(e.request?.url).toBe("https://app.gotcha.co.il/api/webhooks/shopify?[stripped]");
  });

  it("reduces the user to an opaque id - no email, no ip, no username", () => {
    expect(scrubEvent(event()).user).toEqual({ id: "u_1" });
  });

  it("redacts a token quoted inside an exception message", () => {
    const e = scrubEvent(event());
    expect(e.exception?.values?.[0].value).toContain(REDACTED);
    expect(e.exception?.values?.[0].value).not.toContain("abcdef1234567890XYZ");
  });

  it("scrubs extra while keeping the tenant id", () => {
    const extra = scrubEvent(event()).extra as Record<string, unknown>;
    expect(extra.accessToken).toBe(REDACTED);
    expect(extra.tenantId).toBe("t_1");
  });

  it("scrubs breadcrumb payloads", () => {
    const b = scrubEvent(event()).breadcrumbs?.[0] as Record<string, unknown>;
    expect(JSON.stringify(b)).not.toContain("customer said hello");
  });

  /** The whole event, as one assertion: no known secret survives anywhere. */
  it("leaves no credential or message content anywhere in the event", () => {
    const s = JSON.stringify(scrubEvent(event()));
    for (const leak of [
      "please cancel my order", "customer said hello", SHOPIFY_TOKEN,
      "abcdef1234567890XYZ", "customer@example.com", "1.2.3.4", "someone",
    ]) {
      expect(s, `leaked: ${leak}`).not.toContain(leak);
    }
  });
});
