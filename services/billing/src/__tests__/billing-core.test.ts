import { describe, it, expect, beforeAll } from "vitest";
import { periodKeyFor, addMonths, currentPeriod, nextPeriod } from "../lib/period";
import { icountProvider } from "../providers/icount.provider";
import { manualProvider } from "../providers/manual.provider";

beforeAll(() => {
  process.env.ICOUNT_MODE = "mock";
});

describe("billing/period helpers", () => {
  it("derives a stable YYYY-MM period key (UTC)", () => {
    expect(periodKeyFor(new Date("2026-06-15T00:00:00Z"))).toBe("2026-06");
    expect(periodKeyFor(new Date("2026-12-01T00:00:00Z"))).toBe("2026-12");
  });

  it("adds months preserving anchor day and clamping month-end", () => {
    expect(addMonths(new Date("2026-01-31T00:00:00Z"), 1).toISOString().slice(0, 10)).toBe("2026-02-28");
    expect(addMonths(new Date("2026-06-15T00:00:00Z"), 1).toISOString().slice(0, 10)).toBe("2026-07-15");
  });

  it("currentPeriod spans exactly one month from the anchor", () => {
    const p = currentPeriod(new Date("2026-06-10T00:00:00Z"));
    expect(p.key).toBe("2026-06");
    expect(p.end.toISOString().slice(0, 10)).toBe("2026-07-10");
  });

  it("nextPeriod follows the previous period end", () => {
    const p = nextPeriod(new Date("2026-07-10T00:00:00Z"));
    expect(p.key).toBe("2026-07");
    expect(p.end.toISOString().slice(0, 10)).toBe("2026-08-10");
  });
});

describe("billing/iCount provider (mock mode)", () => {
  it("tokenizes + verifies without network", async () => {
    const tok = await icountProvider.tokenizeAndVerify({ pageToken: "pt_abc" });
    expect(tok.token).toBe("icmock_pt_abc");
    expect(tok.last4).toBe("4242");
  });

  it("charges successfully and issues an invoice ref when asked", async () => {
    const res = await icountProvider.charge({
      token: "icmock_x", providerCustomerId: "cli_1",
      amount: 499, currency: "USD",
      // The ILS figure and currency id come from a frozen payment quote.
      chargeAmount: "1821.35", chargeCurrency: "ILS", providerCurrencyId: 5,
      description: "Pro", idempotencyKey: "k1", issueInvoice: true,
    });
    expect(res.success).toBe(true);
    expect(res.providerChargeRef).toBe("chg_k1");
    expect(res.providerInvoiceRef).toBe("inv_k1");
  });

  it("rejects an unsigned webhook even in mock mode", () => {
    // No secret means no verification, and no verification means reject. The
    // endpoint is reachable from the internet in every deployment.
    delete process.env.ICOUNT_WEBHOOK_SECRET;
    expect(icountProvider.verifyWebhook({ headers: {}, rawBody: "{}" })).toBe(false);
  });
});

describe("billing/manual provider", () => {
  it("never charges (grandfathered/manual accounts)", async () => {
    const res = await manualProvider.charge({ token: "manual_no_card", amount: 10, currency: "ILS", description: "x", idempotencyKey: "k" });
    expect(res.success).toBe(false);
    expect(res.failureCode).toBe("manual_provider_no_charge");
  });
});
