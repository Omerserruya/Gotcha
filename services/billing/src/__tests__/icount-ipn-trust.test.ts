/**
 * What an IPN is allowed to do, and what it must never do.
 *
 * The endpoint is public and unauthenticated on purpose - iCount cannot sign a
 * request, so demanding a signature would not secure it, it would silently
 * break it. Safety comes instead from the payload being incapable of causing
 * anything: an IPN selects which of OUR OWN records to re-verify, and the
 * verification then asks iCount directly.
 *
 * These are largely source-level assertions, and deliberately so. The property
 * being protected is "this handler believes nothing it is told", which is about
 * the absence of code rather than the presence of behaviour, and the way it
 * breaks is someone adding a helpful-looking branch that reads a status off the
 * body.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(__dirname, "../routes/icount-ipn.ts"), "utf8");
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("the payload cannot decide anything", () => {
  it("never calls a service that moves money or grants access", () => {
    for (const action of [
      "activatePaidCheckout",
      "executeCharge",
      "chargeFor",
      "grantUnits",
      "refundUnitsForReference",
      "applyChargeback",
      "applyRefundConfirmation",
      "suspendTenants",
      "createSubscription",
      "activateSubscription",
    ]) {
      expect(code, `an IPN must never call ${action}`).not.toContain(action);
    }
  });

  it("reads no outcome field off the body", () => {
    // The fields a forged payload would carry to claim success. Reading any of
    // them is the bug this route exists to not have.
    for (const field of [
      "status",
      "paid",
      "success",
      "approved",
      "confirmation",
      "cc_token",
      "token",
      "sum",
      "amount",
      "currency",
    ]) {
      expect(code, `an IPN must not read body.${field}`).not.toContain(`body.${field}`);
      expect(code, `an IPN must not read body?.${field}`).not.toContain(`body?.${field}`);
    }
  });

  it("writes only the received-event log", () => {
    const writes = code.match(/prisma\.(\w+)\.(create|update|updateMany|delete|deleteMany|upsert)/g) ?? [];
    expect(writes).toEqual(["prisma.billingWebhookEvent.create"]);
  });

  it("records the delivery as RECEIVED and never as processed", () => {
    expect(code).toContain('status: "RECEIVED"');
    expect(code).not.toContain('status: "PROCESSED"');
    expect(code).not.toContain('"VERIFIED"');
  });

  it("establishes what happened by asking iCount, not by reading the body", () => {
    // The single permitted consequence.
    expect(code).toContain("verifyTokenizationSession(session.id)");
  });
});

describe("correlation is a lookup, not an instruction", () => {
  it("matches only against references we generated", () => {
    // customClientId and id are ours. A payload naming anything else matches
    // nothing, which is the point: an attacker cannot aim this at a record.
    expect(code).toContain("customClientId: { in: candidates }");
    expect(code).toContain("id: { in: candidates }");
    // Never a tenant, entity or subscription looked up from a supplied value.
    expect(code).not.toContain("tenantId: body");
    expect(code).not.toContain("findUnique({ where: { tenantId");
  });

  it("accepts the documented correlation field and the ones this integration uses", () => {
    for (const field of ["x_order_id", "custom_client_id", "sale_uniqid"]) {
      expect(source).toContain(field);
    }
  });

  it("bounds what it will take as a reference", () => {
    // An unbounded string from the internet becomes a query parameter.
    expect(code).toContain("v.length <= 200");
  });
});

describe("it does not become an oracle", () => {
  it("answers the same whether or not the reference matched", () => {
    // A response that distinguishes "real session" from "not a session" lets
    // someone enumerate references by watching the replies.
    const responses = code.match(/res\.json\([^)]*\)/g) ?? [];
    const okResponses = responses.filter((r) => r.includes("ok: true"));
    expect(okResponses.length).toBeGreaterThan(0);
    for (const r of okResponses) {
      expect(r).not.toContain("session");
      expect(r).not.toContain("verified");
      expect(r).not.toContain("matched");
    }
  });

  it("bounds the body it will accept", () => {
    expect(code).toContain("MAX_EVENT_BODY_BYTES");
    expect(code).toContain("413");
  });
});

describe("the signature requirement it deliberately does not have", () => {
  it("does not demand a header iCount cannot send", () => {
    // The existing webhook route requires x-icount-signature, an HMAC contract
    // invented on this side. Requiring it here would reject every genuine
    // notification - which is not security, it is an integration that never
    // works while appearing to be protected.
    expect(code).not.toContain("x-icount-signature");
    expect(code).not.toContain("verifyWebhook");
    expect(code).not.toContain("ICOUNT_WEBHOOK_SECRET");
  });
});
