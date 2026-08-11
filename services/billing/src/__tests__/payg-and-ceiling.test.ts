/**
 * The two ceiling bugs, and the mode that would have inherited both.
 *
 * Pay-as-you-go is the only way to spend money here that does not charge a card
 * at the moment it happens, so it is the only one where a broken cap is not
 * discovered until the bill arrives. Both defects found in auto-purchase would
 * have applied to it unchanged:
 *
 *   1. the window keyed on the WALL-CLOCK month, so a subscription anchored on
 *      the 10th reset its cap on the 1st and could spend two ceilings per cycle
 *   2. the ceiling's currency had three different defaults, so "100" meant
 *      either ₪100 or $100 depending on which code path created the row
 *
 * These lock both, at the level they were actually wrong: the window key, and
 * the single currency resolver.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, prisma: {} };
});

import { spendWindowKey, periodKeyFor } from "../lib/period";

describe("the spend window", () => {
  it("anchors to the subscription's cycle, not the calendar month", () => {
    // Anchored on the 10th of July. On 3 August the cycle that began 10 July is
    // still the current one; the calendar has already rolled over.
    const sub = { currentPeriodStart: new Date("2026-07-10T00:00:00.000Z") };
    const duringNextCalendarMonth = new Date("2026-08-03T09:00:00.000Z");

    expect(spendWindowKey(sub, duringNextCalendarMonth)).toBe("2026-07");
    // This is the value the bug used, and the whole distinction in one line.
    expect(periodKeyFor(duringNextCalendarMonth)).toBe("2026-08");
  });

  it("does not reset the ceiling early for a mid-month anchor", () => {
    const sub = { currentPeriodStart: new Date("2026-07-10T00:00:00.000Z") };
    // Every instant inside the cycle has to produce ONE key. If any of these
    // disagreed, the spend recorded before it would read as zero and the
    // customer could spend the cap again.
    const insideTheSameCycle = [
      new Date("2026-07-10T00:00:01.000Z"),
      new Date("2026-07-31T23:59:59.000Z"),
      new Date("2026-08-01T00:00:01.000Z"),
      new Date("2026-08-09T23:00:00.000Z"),
    ];
    const keys = new Set(insideTheSameCycle.map((d) => spendWindowKey(sub, d)));
    expect([...keys]).toEqual(["2026-07"]);
  });

  it("moves to a new window when the subscription renews", () => {
    const before = { currentPeriodStart: new Date("2026-07-10T00:00:00.000Z") };
    const after = { currentPeriodStart: new Date("2026-08-10T00:00:00.000Z") };
    const now = new Date("2026-08-11T00:00:00.000Z");
    expect(spendWindowKey(before, now)).not.toBe(spendWindowKey(after, now));
    expect(spendWindowKey(after, now)).toBe("2026-08");
  });

  it("falls back to the wall clock only when there is nothing to anchor to", () => {
    // A subscription that has never billed. The two agree here anyway, which is
    // why this fallback is safe and the unconditional version was not.
    const now = new Date("2026-08-03T09:00:00.000Z");
    expect(spendWindowKey(null, now)).toBe("2026-08");
    expect(spendWindowKey({ currentPeriodStart: null }, now)).toBe("2026-08");
  });
});

describe("the ceiling's currency", () => {
  it("has exactly one default, and it matches the schema's", async () => {
    const { DEFAULT_COMMERCIAL_CURRENCY } = await import("../lib/currency");
    // BillingProfile.currency is @default("ILS"). The API used to write "USD"
    // when the client omitted it and the settings screen displayed "ILS", so a
    // cap of 100 could mean either. One value, stated once.
    expect(DEFAULT_COMMERCIAL_CURRENCY).toBe("ILS");
  });

  it("is resolved from the profile rather than assumed", async () => {
    const src = await import("fs").then((fs) =>
      fs.readFileSync("src/lib/currency.ts", "utf8"),
    );
    expect(src).toMatch(/prisma\.billingProfile\.findUnique/);
    expect(src).toMatch(/select: \{ currency: true \}/);
  });

  it("is not re-invented at the call sites that create a policy", async () => {
    const fs = await import("fs");
    const credits = fs.readFileSync("src/routes/credits.ts", "utf8");
    const evaluation = fs.readFileSync("src/services/evaluation.service.ts", "utf8");
    // The literal each of these used to carry.
    expect(credits).not.toMatch(/currency:\s*currency\s*\?\?\s*"USD"/);
    expect(credits).toMatch(/commercialCurrencyFor\(/);

    // Scoped to the POLICY create, not the whole file: the evaluation Plan row
    // further up also names a currency, and that one prices nothing (basePrice
    // is null, and it is sales-only with auto-purchase off). Asserting on the
    // file would fail on a line that was never the bug.
    const policyCreate = evaluation.slice(evaluation.indexOf("prisma.autoPurchasePolicy.upsert"));
    const block = policyCreate.slice(0, policyCreate.indexOf("});"));
    expect(block).not.toMatch(/currency:\s*"USD"/);
    expect(block).toMatch(/commercialCurrencyFor\(/);
  });
});

describe("pay-as-you-go, at the level the money moves", () => {
  it("checks the ceiling on every accrual, not at settlement", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("src/services/payg.service.ts", "utf8");
    const accrue = src.slice(src.indexOf("export async function accruePaygUsage"));
    const body = accrue.slice(0, accrue.indexOf("export async function settlePaygPeriod"));
    // A limit applied only when the invoice is drawn up is a receipt.
    expect(body).toMatch(/headroom/);
    expect(body).toMatch(/ceiling/);
    expect(body).toMatch(/ceiling_reached/);
  });

  it("uses the subscription-anchored window, like auto-purchase now does", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("src/services/payg.service.ts", "utf8");
    expect(src).toMatch(/spendWindowKey\(/);
    // The exact call the bug was made of.
    expect(src).not.toMatch(/periodKeyFor\(now\)/);
    expect(src).not.toMatch(/periodKeyFor\(new Date\(\)\)/);
  });

  it("refuses to serve when no rate is configured, rather than serving free", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("../../packages/shared/src/lib/billing/spend-window.ts", "utf8");
    expect(src).toMatch(/if \(!\(rate > 0\)\) return PAYG_OFF/);
  });

  it("settles only a CLOSED window, and claims it before charging", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("src/services/payg.service.ts", "utf8");
    const settle = src.slice(src.indexOf("export async function settlePaygPeriod"));
    // Compare-and-set on status: a retry or a second tick must not bill twice.
    expect(settle).toMatch(/status: "OPEN"[\s\S]*?data: \{ status: "SETTLING" \}/);
    expect(settle).toMatch(/idempotencyKey: `payg:/);
    // The open window is still accruing and must not be billed mid-cycle.
    const sweep = src.slice(src.indexOf("export async function settleDuePaygAccruals"));
    expect(sweep).toMatch(/if \(row\.periodKey === currentKey\) continue/);
  });

  it("hands a failed settlement back to dunning instead of wedging it", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("src/services/payg.service.ts", "utf8");
    const settle = src.slice(src.indexOf("export async function settlePaygPeriod"));
    // Left SETTLING, nothing retries it and the money owed is frozen.
    expect(settle).toMatch(/status: "SETTLING" \}, data: \{ status: "OPEN" \}/);
  });

  it("is reported by the AI runtime on every call, not only on a threshold", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("../ai/src/services/ai.service.ts", "utf8");
    const meter = src.slice(src.indexOf("async function meterAndReact"));
    const body = meter.slice(0, 2500);
    // The shortfall report must come BEFORE the thresholds early-return, or
    // PAYG bills only the calls that land on 80/90/95/100.
    const shortfallAt = body.indexOf("payg-accrue");
    const thresholdReturnAt = body.indexOf("m.thresholds.length === 0) return");
    expect(shortfallAt).toBeGreaterThan(-1);
    expect(thresholdReturnAt).toBeGreaterThan(-1);
    expect(shortfallAt).toBeLessThan(thresholdReturnAt);
  });
});
