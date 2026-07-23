import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createHmac } from "crypto";
import { icountProvider } from "../providers/icount.provider";

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
    const r = await icountProvider.charge({
      token: "icmock_x", amount: 10, currency: "ILS", description: "t", idempotencyKey: "k1",
    } as any);
    expect(r.success).toBe(true);
    expect(r.providerChargeRef).toBe("chg_k1");
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
    await expect(
      icountProvider.charge({ token: "t", amount: 1, currency: "ILS", description: "x", idempotencyKey: "k" } as any),
    ).rejects.toThrow(/refusing live charge/);
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

  it("without a secret: accepts only in mock mode, rejects in live", () => {
    expect(icountProvider.verifyWebhook({ headers: {}, rawBody: body })).toBe(true); // mock
    process.env.ICOUNT_MODE = "live";
    expect(icountProvider.verifyWebhook({ headers: {}, rawBody: body })).toBe(false); // live w/o secret
  });
});
