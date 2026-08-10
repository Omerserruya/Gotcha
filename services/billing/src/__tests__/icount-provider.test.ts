import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createHmac } from "crypto";
import { icountProvider } from "../providers/icount.provider";

/**
 * A well-formed charge. The ILS amount and currency id come from a frozen
 * payment quote in real use; here they are spelled out so each test overrides
 * only the field it is about.
 */
function CHARGE(over: Record<string, any> = {}): any {
  return {
    token: "icmock_x",
    providerCustomerId: "cli_1",
    amount: 499,
    currency: "USD",
    chargeAmount: "1821.35",
    chargeCurrency: "ILS",
    providerCurrencyId: 5,
    description: "t",
    idempotencyKey: "k1",
    ...over,
  };
}

// The provider resolves ICOUNT_MODE at CALL time, so each test can set the
// environment it needs. Restore a safe default afterwards.
const ORIGINAL = { ...process.env };
function resetEnv() {
  process.env.ICOUNT_MODE = "mock";
  delete process.env.ICOUNT_ALLOW_LIVE;
  delete process.env.ICOUNT_WEBHOOK_SECRET;
}
beforeEach(resetEnv);
afterAll(() => {
  process.env = ORIGINAL;
});

describe("icount provider: mock mode (dev/E2E default)", () => {
  it("tokenizes deterministically with NO network and stores only safe refs", async () => {
    const tok = await icountProvider.tokenizeAndVerify({ pageToken: "pt_dev" });
    expect(tok.token).toBe("icmock_pt_dev");
    expect(tok.brand).toBe("visa");
    expect(tok.last4).toBe("4242");
    // Nothing resembling a PAN anywhere in the result.
    expect(JSON.stringify(tok)).not.toMatch(/\d{13,19}/);
  });

  it("charges deterministically (idempotency-keyed refs, no network)", async () => {
    const r = await icountProvider.charge(CHARGE({ idempotencyKey: "k1" }));
    expect(r.success).toBe(true);
    expect(r.providerChargeRef).toBe("chg_k1");
  });

  it("holds mock to the same argument rules as live", async () => {
    // A mock that is more permissive than production certifies code that would
    // fail on the real thing.
    await expect(icountProvider.charge(CHARGE({ providerCurrencyId: 2 }))).rejects.toThrow(/currency_id 2/);
    await expect(icountProvider.charge(CHARGE({ chargeCurrency: "USD" }))).rejects.toThrow(/only ILS/);
    await expect(icountProvider.charge(CHARGE({ chargeAmount: "0" }))).rejects.toThrow(/positive charge amount/);
    await expect(icountProvider.charge(CHARGE({ providerCustomerId: undefined }))).rejects.toThrow(
      /no client identifier/,
    );
  });
});

describe("icount provider: live-charge environment guard", () => {
  it("refuses live tokenize outside production even with ICOUNT_MODE=live", async () => {
    process.env.ICOUNT_MODE = "live";
    await expect(icountProvider.tokenizeAndVerify({ pageToken: "pt_x" })).rejects.toThrow(/refusing live tokenize/);
  });

  it("refuses live charge without the explicit ICOUNT_ALLOW_LIVE acknowledgement", async () => {
    process.env.ICOUNT_MODE = "live";
    // Even a (hypothetical) production NODE_ENV is not enough on its own.
    // The env guard fires before argument validation, so a misconfigured stack
    // is told it may not charge at all rather than that its amount was wrong.
    await expect(icountProvider.charge(CHARGE())).rejects.toThrow(/refusing live charge/);
    await expect(icountProvider.charge(CHARGE({ chargeAmount: undefined }))).rejects.toThrow(
      /refusing live charge/,
    );
  });

  it("refuses live refund under the same guard", async () => {
    process.env.ICOUNT_MODE = "live";
    await expect(
      icountProvider.refund({ providerChargeRef: "c", amount: 1, currency: "ILS", idempotencyKey: "k" } as any),
    ).rejects.toThrow(/refusing live refund/);
  });
});

describe("icount provider: webhook signature verification", () => {
  const body = JSON.stringify({ event: "charge.succeeded", id: "x1" });

  it("accepts a valid HMAC signature", () => {
    process.env.ICOUNT_WEBHOOK_SECRET = "whsec_test";
    const sig = createHmac("sha256", "whsec_test").update(body).digest("hex");
    expect(icountProvider.verifyWebhook({ headers: { "x-icount-signature": sig }, rawBody: body })).toBe(true);
  });

  it("rejects a forged or truncated signature", () => {
    process.env.ICOUNT_WEBHOOK_SECRET = "whsec_test";
    const forged = createHmac("sha256", "wrong_secret").update(body).digest("hex");
    expect(icountProvider.verifyWebhook({ headers: { "x-icount-signature": forged }, rawBody: body })).toBe(false);
    expect(icountProvider.verifyWebhook({ headers: { "x-icount-signature": "deadbeef" }, rawBody: body })).toBe(false);
    expect(icountProvider.verifyWebhook({ headers: {}, rawBody: body })).toBe(false);
  });

  it("without a secret: rejects in EVERY mode", () => {
    // This used to accept unsigned webhooks outside live mode. The route is
    // publicly reachable, so "only in dev" was not a property it had - anyone
    // able to reach the endpoint could post whatever they liked.
    for (const mode of ["mock", "simulator", "live"]) {
      process.env.ICOUNT_MODE = mode;
      expect(
        icountProvider.verifyWebhook({ headers: {}, rawBody: body }),
        `mode=${mode} must reject an unsigned webhook`,
      ).toBe(false);
    }
  });
});
