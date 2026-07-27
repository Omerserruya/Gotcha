/**
 * The official Bank of Israel rate, and the ways it can go wrong.
 *
 * The response shape here is not invented. It was probed against the live
 * official endpoint, because the documentation page sits behind a Radware
 * challenge and cannot be read:
 *
 *   GET https://boi.org.il/PublicApi/GetExchangeRate?key=USD&asJson=true
 *   {"key":"USD","currentExchangeRate":3.04,"currentChange":-0.71,
 *    "unit":1,"lastUpdate":"2026-07-27T12:21:03.6610401Z"}
 *
 * The cases that matter are the unhappy ones. A central bank that does not
 * publish at weekends, a feed that goes down, a response that parses but is
 * nonsense - each has a different right answer, and getting them wrong means
 * either charging at a number nobody can defend or refusing to charge anyone.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";

const fetchMock = vi.fn();

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return { ...actual, safeFetch: (...a: unknown[]) => fetchMock(...a) };
});

import { prisma } from "@chatcenter/shared";
import { Prisma } from "@prisma/client";
import {
  boiExchangeRateProvider,
  parseRateEntry,
  resetFxMetrics,
  fxMetrics,
  BOI_SOURCE,
  ExchangeRateUnavailable as ProviderUnavailable,
} from "../providers/boi-fx.provider";
import {
  activeRate,
  fetchAndStoreOfficialRate,
  proposeRate,
  approveRate,
  clearRateCache,
  maxStalenessHours,
  ExchangeRateUnavailable,
  ExchangeRateRefused,
} from "../services/exchange-rate.service";

const RUN = `boi-${Date.now()}`;
const rateIds: string[] = [];
const ORIGINAL = { ...process.env };
let restoreId: string | null = null;

/** The exact shape the live endpoint returns. */
function officialBody(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    key: "USD",
    currentExchangeRate: 3.04,
    currentChange: -0.7184846505551926845199216200,
    unit: 1,
    lastUpdate: new Date().toISOString(),
    ...over,
  });
}

function ok(body: string) {
  return { ok: true, status: 200, text: body };
}

async function clearRates() {
  await prisma.paymentQuote.deleteMany({ where: { fxRateId: { in: rateIds } } }).catch(() => undefined);
  await prisma.billingExchangeRate.updateMany({
    where: { baseCurrency: "USD", quoteCurrency: "ILS", status: "ACTIVE" },
    data: { status: "RETIRED" },
  });
  clearRateCache();
}

beforeEach(async () => {
  vi.clearAllMocks();
  resetFxMetrics();
  clearRateCache();
  process.env.BOI_FX_ENABLED = "true";
  process.env.BOI_FX_MAX_STALENESS_HOURS = "120";
  await clearRates();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

afterAll(async () => {
  await prisma.paymentQuote.deleteMany({ where: { fxRateId: { in: rateIds } } }).catch(() => undefined);
  await prisma.billingExchangeRate.deleteMany({
    where: { OR: [{ id: { in: rateIds } }, { createdBy: { startsWith: RUN } }, { source: BOI_SOURCE }] },
  });
  if (restoreId) {
    await prisma.billingExchangeRate.update({ where: { id: restoreId }, data: { status: "ACTIVE" } }).catch(() => undefined);
  }
  process.env = { ...ORIGINAL };
});

describe("the official response is read correctly", () => {
  it("parses the live shape and keeps the published digits", async () => {
    fetchMock.mockResolvedValue(ok(officialBody()));
    const r = await boiExchangeRateProvider.getLatestRate("USD", "ILS");

    expect(r.rate).toBe("3.04");
    expect(r.baseCurrency).toBe("USD");
    expect(r.quoteCurrency).toBe("ILS");
    expect(r.source).toBe(BOI_SOURCE);
    expect(r.rawResponseHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.isCurrentBusinessDay).toBe(true);
  });

  it("records when the BANK published it, not when we read it", async () => {
    const published = new Date(Date.now() - 30 * 3_600_000);
    fetchMock.mockResolvedValue(ok(officialBody({ lastUpdate: published.toISOString() })));
    const r = await boiExchangeRateProvider.getLatestRate("USD", "ILS");

    // A rate read on Sunday still carries Friday's publication date, and that
    // is the date a customer or an auditor would recognise.
    expect(r.officialDate.toISOString()).toBe(published.toISOString());
    expect(r.retrievedAt.getTime()).toBeGreaterThan(published.getTime());
    expect(r.isCurrentBusinessDay).toBe(false);
  });

  it("divides by unit, which is a 100x error waiting to happen", () => {
    // The BOI publishes some currencies per HUNDRED units - JPY is quoted that
    // way today. USD is unit 1, so ignoring the field looks fine until the day
    // it is not, and then every charge is 100x wrong.
    //
    // Quoted per 100 units, the same real rate of 3.04 arrives as 304.
    const perHundred = parseRateEntry(
      { key: "USD", currentExchangeRate: 304, unit: 100, lastUpdate: new Date().toISOString() },
      "{}",
      new Date(),
    );
    expect(perHundred.rate).toBe("3.04");

    // And without the division it would be 304 - which the plausibility band
    // would reject outright, because a USD/ILS rate is never near it.
    expect(() =>
      parseRateEntry(
        { key: "USD", currentExchangeRate: 304, unit: 1, lastUpdate: new Date().toISOString() },
        "{}",
        new Date(),
      ),
    ).toThrow(/rate_implausible/);
  });

  it("never routes the rate through a binary float", async () => {
    // 3.04 has no exact binary representation. If it went through arithmetic as
    // a JS number the stored value would drift in the last places.
    fetchMock.mockResolvedValue(ok(officialBody({ currentExchangeRate: 3.04 })));
    const r = await boiExchangeRateProvider.getLatestRate("USD", "ILS");
    expect(new Prisma.Decimal(r.rate).toFixed(10)).toBe("3.0400000000");
  });
});

describe("a response that parses but is nonsense fails closed", () => {
  it.each([
    ["a rate of zero", { currentExchangeRate: 0 }],
    ["a negative rate", { currentExchangeRate: -3.04 }],
    ["an absurd rate", { currentExchangeRate: 950 }],
    ["a zero unit", { unit: 0 }],
    ["a missing publication date", { lastUpdate: "" }],
    ["a publication date in the future", { lastUpdate: new Date(Date.now() + 5 * 86_400_000).toISOString() }],
    ["the wrong currency", { key: "EUR" }],
  ])("refuses %s", async (_label, over) => {
    fetchMock.mockResolvedValue(ok(officialBody(over)));
    // Each of these would otherwise become the number on someone's statement.
    await expect(boiExchangeRateProvider.getLatestRate("USD", "ILS")).rejects.toBeInstanceOf(ProviderUnavailable);
  });

  it("does not retry a malformed response", async () => {
    fetchMock.mockResolvedValue(ok(officialBody({ currentExchangeRate: 0 })));
    await expect(boiExchangeRateProvider.getLatestRate("USD", "ILS")).rejects.toThrow();
    // Bad JSON will not become good JSON on a second attempt; retrying only
    // burns the budget that transient failures need.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a transport failure, then gives up", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, text: "" });
    await expect(boiExchangeRateProvider.getLatestRate("USD", "ILS")).rejects.toThrow(/source_unreachable/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops calling after repeated failures", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, text: "" });
    await expect(boiExchangeRateProvider.getLatestRate("USD", "ILS")).rejects.toThrow();
    fetchMock.mockClear();
    // The circuit is open: hammering a struggling endpoint helps nobody.
    await expect(boiExchangeRateProvider.getLatestRate("USD", "ILS")).rejects.toThrow(/circuit_open/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fxMetrics.circuitOpenUntil).toBeTruthy();
  });
});

describe("weekends, holidays and staleness", () => {
  it("uses Friday's rate on a Sunday", async () => {
    const friday = new Date(Date.now() - 48 * 3_600_000);
    fetchMock.mockResolvedValue(ok(officialBody({ lastUpdate: friday.toISOString() })));
    const stored = await fetchAndStoreOfficialRate();
    rateIds.push(stored.id);

    // The BOI does not publish at weekends. Refusing to charge for two days
    // every week would be a worse failure than using the published figure.
    expect(stored.status).toBe("ACTIVE");
    expect(stored.officialDate!.toISOString()).toBe(friday.toISOString());
    expect(String(stored.rate)).toBe("3.04");
  });

  it("serves a stored weekend rate without calling the source again", async () => {
    const friday = new Date(Date.now() - 40 * 3_600_000);
    fetchMock.mockResolvedValue(ok(officialBody({ lastUpdate: friday.toISOString() })));
    rateIds.push((await fetchAndStoreOfficialRate()).id);

    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: false, status: 503, text: "" });
    const r = await activeRate();
    // The feed is down and it does not matter: the stored rate is still inside
    // its permitted window.
    expect(String(r.rate)).toBe("3.04");
  });

  it("refuses once the published rate is older than the permitted window", async () => {
    const ancient = new Date(Date.now() - (maxStalenessHours() + 24) * 3_600_000);
    fetchMock.mockResolvedValue(ok(officialBody({ lastUpdate: ancient.toISOString() })));

    // Beyond the window a rate is not "old", it is unusable. Charging on it
    // would be charging at a number nobody can stand behind.
    await expect(fetchAndStoreOfficialRate()).rejects.toThrow(/too_stale/);
    await expect(activeRate()).rejects.toBeInstanceOf(ExchangeRateUnavailable);
  });

  it("does not fall back to an expired stored rate when the feed is down", async () => {
    const stale = new Date(Date.now() - 20 * 3_600_000);
    fetchMock.mockResolvedValue(ok(officialBody({ lastUpdate: stale.toISOString() })));
    const stored = await fetchAndStoreOfficialRate();
    rateIds.push(stored.id);

    // Force the stored rate past its hard expiry, then take the feed away.
    await prisma.billingExchangeRate.update({
      where: { id: stored.id },
      data: { maxUseUntil: new Date(Date.now() - 1000) },
    });
    clearRateCache();
    fetchMock.mockResolvedValue({ ok: false, status: 503, text: "" });

    // Falling back to it here is exactly the silent-stale-rate failure this
    // whole design exists to prevent.
    await expect(activeRate()).rejects.toThrow(/no_usable_rate|no_active_rate/);
  });

  it("charging is off when the feed is disabled and nothing is stored", async () => {
    process.env.BOI_FX_ENABLED = "false";
    await expect(activeRate()).rejects.toThrow(/no_active_rate/);
  });
});

describe("approval follows who is asserting something", () => {
  it("an official rate needs no approver at all", async () => {
    fetchMock.mockResolvedValue(ok(officialBody()));
    const stored = await fetchAndStoreOfficialRate();
    rateIds.push(stored.id);

    // Requiring two people to sign off the central bank's own daily figure
    // would stop charging every weekend nobody is watching.
    expect(stored.status).toBe("ACTIVE");
    expect(stored.origin).toBe("AUTOMATIC_OFFICIAL");
    expect(stored.approvedBy).toBeNull();
    expect(stored.createdBy).toBeNull();
    expect(stored.verificationState).toBe("VERIFIED_OFFICIAL");

    const inForce = await activeRate();
    expect(inForce.id).toBe(stored.id);
  });

  it("a manual override needs two different people", async () => {
    const draft = await proposeRate({ rate: "3.90", reason: "provider outage", createdBy: `${RUN}-alice` });
    rateIds.push(draft.id);
    expect(draft.status).toBe("DRAFT");

    await expect(approveRate({ id: draft.id, approvedBy: `${RUN}-alice` })).rejects.toThrow(
      /approver_must_differ_from_creator/,
    );
    const approved = await approveRate({ id: draft.id, approvedBy: `${RUN}-bob` });
    expect(approved.status).toBe("ACTIVE");
    expect(approved.origin).toBe("MANUAL_OVERRIDE");
  });

  it("an override requires a stated reason", async () => {
    await expect(
      proposeRate({ rate: "3.90", reason: "   ", createdBy: `${RUN}-alice` }),
    ).rejects.toBeInstanceOf(ExchangeRateRefused);
  });

  it("an expired override cannot be approved into force", async () => {
    const draft = await proposeRate({
      rate: "3.90",
      reason: "outage",
      createdBy: `${RUN}-alice`,
      activeFrom: new Date(Date.now() - 10 * 3_600_000),
      expiresAt: new Date(Date.now() - 1000),
    });
    rateIds.push(draft.id);
    await expect(approveRate({ id: draft.id, approvedBy: `${RUN}-bob` })).rejects.toThrow(/override_expired/);
  });

  it("an approved override outranks the official feed while it lives", async () => {
    fetchMock.mockResolvedValue(ok(officialBody()));
    rateIds.push((await fetchAndStoreOfficialRate()).id);

    const draft = await proposeRate({ rate: "3.90", reason: "disputed feed", createdBy: `${RUN}-alice` });
    rateIds.push(draft.id);
    await approveRate({ id: draft.id, approvedBy: `${RUN}-bob` });

    const inForce = await activeRate();
    // A person deliberately said "use this". The feed must not quietly undo it.
    expect(String(inForce.rate)).toBe("3.9");
    expect(inForce.origin).toBe("MANUAL_OVERRIDE");
  });

  it("an official rate cannot be pushed through the approval path", async () => {
    fetchMock.mockResolvedValue(ok(officialBody()));
    const stored = await fetchAndStoreOfficialRate();
    rateIds.push(stored.id);
    await expect(approveRate({ id: stored.id, approvedBy: `${RUN}-bob` })).resolves.toBeTruthy();
  });
});

describe("the rate cannot come from a browser", () => {
  it("no request field anywhere sets the rate or the charged amount", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const rel of [
      "../routes/checkout.ts",
      "../routes/checkout-session.ts",
      "../services/payment-quote.service.ts",
      "../services/charge-execution.service.ts",
    ]) {
      const code = readFileSync(join(__dirname, rel), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      for (const forbidden of ["req.body.rate", "req.body.amount", "req.body.chargeAmount", "req.body.fxRate", "body.currency"]) {
        expect(code, `${rel} must not read ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
