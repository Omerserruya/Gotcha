/**
 * The webhook endpoint, and what it must never become again.
 *
 * It used to read an event `type` off the payload and, on
 * `payment.chargeback`, suspend the tenant and claw back their credits. The
 * event names were invented - iCount's callback contract has never been
 * verified - and the route is publicly reachable and accepted unsigned payloads
 * outside live mode. The combination meant anyone able to reach the endpoint
 * could suspend a paying organization by posting a guessed string.
 *
 * These are source-level assertions on purpose. The behaviour they protect is
 * "this handler does nothing", which a behavioural test cannot really express -
 * and the failure mode is someone adding a helpful-looking branch back.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const route = readFileSync(join(__dirname, "../routes/webhooks.ts"), "utf8");
const code = route.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("a webhook can change nothing", () => {
  it("calls no state-changing service", () => {
    for (const action of [
      "applyChargeback",
      "applyRefundConfirmation",
      "refundCharge",
      "activatePaidCheckout",
      "executeCharge",
      "suspendTenants",
      "grantUnits",
      "refundUnitsForReference",
    ]) {
      expect(code, `a webhook must never call ${action}`).not.toContain(action);
    }
  });

  it("writes only the event log", () => {
    // One write, to one table. Anything else is the handler doing something.
    const writes = code.match(/prisma\.(\w+)\.(create|update|updateMany|delete|deleteMany|upsert)/g) ?? [];
    expect(writes).toEqual(["prisma.billingWebhookEvent.create"]);
  });

  it("does not branch on the event type", () => {
    // The type is recorded for a human and must not select a code path: those
    // strings were guesses at a contract nobody has confirmed.
    expect(code).not.toMatch(/eventType\s*===/);
    expect(code).not.toMatch(/payment\.(refunded|chargeback|disputed|succeeded)/);
  });

  it("never records an event as processed", () => {
    expect(code).toContain('status: "RECEIVED"');
    expect(code).not.toContain('"PROCESSED"');
  });

  it("does not look up a charge by a reference from the payload", () => {
    // Resolving a victim from an attacker-supplied reference is how a targeted
    // payload finds its target.
    expect(code).not.toContain("prisma.charge.findFirst");
    expect(code).not.toContain("providerChargeRef");
  });
});

describe("a webhook must be signed", () => {
  it("rejects before anything is read or written", () => {
    const verifyAt = code.indexOf("verifyWebhook");
    const writeAt = code.indexOf("billingWebhookEvent.create");
    expect(verifyAt).toBeGreaterThan(-1);
    // Ordering matters: persisting first would let an unsigned flood fill the
    // table even though nothing acted on it.
    expect(verifyAt).toBeLessThan(writeAt);
    expect(code).toContain('status(401)');
  });

  it("bounds the body", () => {
    expect(code).toContain("MAX_EVENT_BODY_BYTES");
    expect(code).toContain("413");
  });

  it("redacts what it stores", () => {
    // Card and credential fields are removed before the payload is written.
    expect(code).toContain("redactEventPayload");
    expect(code).not.toMatch(/payload:\s*event\b/);
  });
});

describe("the signature check itself", () => {
  const provider = readFileSync(join(__dirname, "../providers/icount.provider.ts"), "utf8");

  it("has no mode in which an unsigned webhook is accepted", () => {
    const body = provider.slice(provider.indexOf("verifyWebhook("));
    const stripped = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    // The old line was `if (!secret) return icountMode() !== "live"`.
    expect(stripped).toContain("if (!secret) return false");
    expect(stripped.slice(0, 400)).not.toContain("icountMode()");
  });

  it("compares in constant time", () => {
    expect(provider).toContain("timingSafeEqual");
    // A length check first, because timingSafeEqual throws on a mismatch.
    expect(provider).toContain("sig.length === expected.length");
  });
});

describe("a declined customer is told why", () => {
  const shared = readFileSync(join(__dirname, "../lib/decline-category.ts"), "utf8");
  const status = readFileSync(join(__dirname, "../routes/checkout.ts"), "utf8");
  const session = readFileSync(join(__dirname, "../routes/checkout-session.ts"), "utf8");

  it("categorises rather than passing the provider's words through", async () => {
    const { declineCategory } = await import("../lib/decline-category");
    expect(declineCategory("card expired")).toBe("CARD_EXPIRED");
    expect(declineCategory("insufficient funds")).toBe("INSUFFICIENT_FUNDS");
    expect(declineCategory("invalid token")).toBe("CARD_UNUSABLE");
    // An unrecognised code is still a refusal. Passing its text through would
    // leak exactly what this exists to avoid.
    expect(declineCategory("ERR_7734 acct 4021 blocked by issuer policy")).toBe("DECLINED");
    expect(declineCategory(undefined)).toBe("DECLINED");
  });

  it("both surfaces use the SAME categoriser", () => {
    // Two copies would drift, and the same decline would then be described
    // differently depending on which request surfaced it.
    expect(status).toContain('from "../lib/decline-category"');
    expect(session).toContain('from "../lib/decline-category"');
    expect(session).not.toMatch(/function categorize\(/);
  });

  it("the status read exposes it, so the page knows on load", () => {
    // Only returning it from `advance` would mean a customer arriving fresh
    // from their email sees "one step left" after a decline.
    expect(status).toContain("declineCategory:");
    expect(status).toContain('attempt?.state === "FAILED"');
  });

  it("never returns the raw failure code to a customer", () => {
    const body = status.slice(status.indexOf("res.json({"));
    // As a returned FIELD. Passing it into the categoriser is the whole point;
    // emitting it is the thing that must not happen.
    expect(body).not.toMatch(/^\s*failureCode\s*:/m);
    expect(body).not.toMatch(/failure_code/);
    // ...and the categorised form IS returned.
    expect(body).toMatch(/declineCategory:/);
  });
});
