/**
 * One failing job must not take the others down with it.
 *
 * The tick runs renewals, dunning, usage settlement, reconciliation,
 * housekeeping and retention. They share nothing but a schedule, and until now
 * a throw in the first skipped everything after it.
 *
 * The consequence worth naming: a single bad subscription row would silently
 * stop reconciliation, the job that resolves charges where a customer was
 * billed without getting their plan, or given a plan without being billed.
 * Those are precisely the cases nobody notices until they are old and
 * expensive - and the outage would have looked like one warning line an hour.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const cycle = vi.fn();
const dunning = vi.fn();
const usage = vi.fn();
const reconcile = vi.fn();
const leases = vi.fn();
const quotes = vi.fn();
const sessions = vi.fn();
const retention = vi.fn();
const payg = vi.fn();

vi.mock("../services/subscription.service", () => ({ runBillingCycle: () => cycle() }));
vi.mock("../services/dunning.service", () => ({ runDunning: () => dunning() }));
vi.mock("../services/reconciliation.service", () => ({ sweepUnknownAttempts: () => reconcile() }));
vi.mock("../services/payment-attempt.service", () => ({ expireStaleLeases: () => leases() }));
vi.mock("../services/payment-quote.service", () => ({ expireStaleQuotes: () => quotes() }));
vi.mock("../services/tokenization.service", () => ({ expireStaleSessions: () => sessions() }));
vi.mock("../services/billing-retention.service", () => ({ purgeSpentCheckoutArtifacts: () => retention() }));
vi.mock("../services/payg.service", () => ({ settleDuePaygAccruals: () => payg() }));
vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return { ...actual, settleDueConversations: () => usage() };
});

import { runSchedulerTick, tickWasEventful } from "../services/scheduler.service";

const OK = {
  cycle: { trials: 0, renewals: 2, pending: 0, pocsExpired: 0, lotsExpired: 0 },
  dunning: { retried: 1, suspended: 0 },
  usage: { settled: 3, discovered: 4 },
  reconcile: { examined: 5, resolvedPaid: 1, resolvedUnpaid: 1, escalated: 3 },
  retention: { tokenizationSessions: 6, continuationLinks: 7, unusedQuotes: 8 },
  payg: { settled: 1, amount: 12.5 },
};

beforeEach(() => {
  vi.clearAllMocks();
  cycle.mockResolvedValue(OK.cycle);
  dunning.mockResolvedValue(OK.dunning);
  usage.mockResolvedValue(OK.usage);
  reconcile.mockResolvedValue(OK.reconcile);
  leases.mockResolvedValue(undefined);
  quotes.mockResolvedValue(0);
  sessions.mockResolvedValue(0);
  retention.mockResolvedValue(OK.retention);
  payg.mockResolvedValue(OK.payg);
});

describe("a clean tick runs everything", () => {
  it("calls every stage once and reports their results", async () => {
    const r = await runSchedulerTick();
    for (const fn of [cycle, dunning, usage, payg, reconcile, leases, quotes, sessions, retention]) {
      expect(fn).toHaveBeenCalledTimes(1);
    }
    expect(r.failed).toEqual([]);
    expect(r.cycle.renewals).toBe(2);
    expect(r.reconciled.examined).toBe(5);
    expect(r.purged.continuationLinks).toBe(7);
  });
});

describe("a failing stage is contained", () => {
  it("renewals failing does not stop reconciliation", async () => {
    cycle.mockRejectedValue(new Error("one bad subscription row"));
    const r = await runSchedulerTick();

    // The whole point. Reconciliation is the job that finds customers who were
    // charged without getting their plan.
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(r.reconciled.examined).toBe(5);
    expect(r.failed).toEqual(["cycle"]);
    // ...and the failed stage reports neutral rather than a stale number.
    expect(r.cycle.renewals).toBe(0);
  });

  it("dunning failing does not stop retention", async () => {
    dunning.mockRejectedValue(new Error("boom"));
    const r = await runSchedulerTick();
    expect(retention).toHaveBeenCalledTimes(1);
    expect(r.failed).toEqual(["dunning"]);
  });

  it("reconciliation failing does not stop housekeeping", async () => {
    reconcile.mockRejectedValue(new Error("provider unreachable"));
    const r = await runSchedulerTick();
    expect(leases).toHaveBeenCalled();
    expect(quotes).toHaveBeenCalled();
    expect(sessions).toHaveBeenCalled();
    expect(retention).toHaveBeenCalled();
    expect(r.failed).toEqual(["reconcile"]);
  });

  it("survives every stage failing at once", async () => {
    for (const fn of [cycle, dunning, usage, payg, reconcile, leases, quotes, sessions, retention]) {
      fn.mockRejectedValue(new Error("everything is down"));
    }
    const r = await runSchedulerTick();

    // The tick itself must not throw - it is called from a setInterval with
    // nobody to catch it, and a rejected timer callback is how a scheduler dies
    // quietly.
    expect(r.failed).toEqual(["cycle", "dunning", "usage", "payg", "reconcile", "leases", "quotes", "sessions", "retention"]);
    expect(r.reconciled.examined).toBe(0);
  });

  it("names which stages failed, not just that the cycle did", async () => {
    cycle.mockRejectedValue(new Error("a"));
    sessions.mockRejectedValue(new Error("b"));
    const r = await runSchedulerTick();
    // An operator reading "the cycle failed" learns nothing about what was
    // skipped. Naming the stage is the difference between a warning and a lead.
    expect(r.failed).toEqual(["cycle", "sessions"]);
  });
});

describe("the log line appears when it should", () => {
  it("stays quiet on an idle, clean tick", async () => {
    cycle.mockResolvedValue({ trials: 0, renewals: 0, pending: 0, pocsExpired: 0, lotsExpired: 0 });
    dunning.mockResolvedValue({ retried: 0, suspended: 0 });
    usage.mockResolvedValue({ settled: 0, discovered: 0 });
    reconcile.mockResolvedValue({ examined: 0, resolvedPaid: 0, resolvedUnpaid: 0, escalated: 0 });
    retention.mockResolvedValue({ tokenizationSessions: 0, continuationLinks: 0, unusedQuotes: 0 });
    payg.mockResolvedValue({ settled: 0, amount: 0 });
    // Hourly noise trains people to ignore the channel the failures arrive on.
    expect(tickWasEventful(await runSchedulerTick())).toBe(false);
  });

  it("speaks up on an idle tick that had a failure", async () => {
    cycle.mockRejectedValue(new Error("boom"));
    dunning.mockResolvedValue({ retried: 0, suspended: 0 });
    usage.mockResolvedValue({ settled: 0, discovered: 0 });
    reconcile.mockResolvedValue({ examined: 0, resolvedPaid: 0, resolvedUnpaid: 0, escalated: 0 });
    retention.mockResolvedValue({ tokenizationSessions: 0, continuationLinks: 0, unusedQuotes: 0 });
    // A silent failing tick is the worst case: nothing running, nobody told.
    expect(tickWasEventful(await runSchedulerTick())).toBe(true);
  });
});
