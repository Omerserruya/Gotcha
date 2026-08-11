/**
 * The billing tick.
 *
 * Renewals, dunning, usage settlement, reconciliation, housekeeping and
 * retention, once an hour.
 *
 * The property that matters here is isolation. These stages have nothing to do
 * with each other, and until now a throw in the first one skipped every stage
 * after it - so a single bad subscription row would silently stop
 * reconciliation, which is the job that resolves charges where a customer was
 * either billed without getting their plan or given a plan without being
 * billed. Those are exactly the cases nobody notices until they are old.
 *
 * So every stage runs behind its own guard, and the tick reports which ones
 * failed rather than only that "the cycle" did. Extracted from index.ts because
 * a scheduler you cannot call from a test is a scheduler nobody has tested.
 *
 * Running on several instances at once is safe without a leader lock, because
 * every charge is keyed from the subscription and period rather than from the
 * worker or the clock. That is a property of the keys, not of the scheduler -
 * see scheduler-multi-instance.integration.test.ts.
 */
import { runBillingCycle } from "./subscription.service";
import { refreshOfficialRateIfDue } from "./exchange-rate.service";
import { runDunning } from "./dunning.service";
import { settleDueConversations } from "@chatcenter/shared";
import { sweepUnknownAttempts } from "./reconciliation.service";
import { expireStaleLeases } from "./payment-attempt.service";
import { expireStaleQuotes } from "./payment-quote.service";
import { expireStaleSessions } from "./tokenization.service";
import { purgeSpentCheckoutArtifacts } from "./billing-retention.service";
import { settleDuePaygAccruals } from "./payg.service";

export interface TickResult {
  cycle: Awaited<ReturnType<typeof runBillingCycle>>;
  dunning: { retried: number; suspended: number };
  usage: { settled: number; discovered: number };
  payg: { settled: number; amount: number };
  reconciled: { examined: number; resolvedPaid: number; resolvedUnpaid: number; escalated: number };
  purged: { tokenizationSessions: number; continuationLinks: number; unusedQuotes: number };
  /** Stages that threw. Empty on a clean tick. */
  failed: string[];
}

/**
 * Run one stage, and never let its failure become someone else's.
 *
 * The fallback is a neutral result rather than a rethrow, so the caller reads a
 * complete picture: what ran, what it did, and what did not run at all.
 */
async function stage<T>(name: string, run: () => Promise<T>, fallback: T, failed: string[]): Promise<T> {
  try {
    return await run();
  } catch (err: any) {
    failed.push(name);
    console.warn(`[billing][tick] ${name} failed:`, err?.message ?? err);
    return fallback;
  }
}

/** One pass of every scheduled billing job. Safe to call directly in a test. */
export async function runSchedulerTick(): Promise<TickResult> {
  const failed: string[] = [];

  // The official rate first: a renewal that runs before the day's rate is
  // fetched would either use yesterday's or fail, and both are avoidable by
  // simply asking first.
  await stage("fx", () => refreshOfficialRateIfDue(), undefined as any, failed);

  const cycle = await stage(
    "cycle",
    () => runBillingCycle(),
    { trials: 0, renewals: 0, pending: 0, pocsExpired: 0, lotsExpired: 0 },
    failed,
  );
  const dunning = await stage("dunning", () => runDunning(), { retried: 0, suspended: 0 }, failed);

  // Sysadmin cost analytics: discover conversations that closed since the last
  // tick and settle the ones whose late-job window has elapsed. Runs here rather
  // than on conversation close so the AI hot path never waits on aggregation.
  const usage = await stage("usage", () => settleDueConversations(), { settled: 0, discovered: 0 }, failed);

  // Pay-as-you-go is the only mode that bills in arrears, so a closed window
  // owes money nobody has charged yet. Driven from here rather than from
  // renewal alone: a subscription that fails to renew must still be billed for
  // what it already consumed.
  const payg = await stage("payg", () => settleDuePaygAccruals(), { settled: 0, amount: 0 }, failed);

  // Charges whose outcome we never learned. Nothing else resolves them, and
  // left alone they are either a customer who paid and did not get their plan,
  // or one who did not pay and did. Both need answering.
  const reconciled = await stage(
    "reconcile",
    () => sweepUnknownAttempts(),
    { examined: 0, resolvedPaid: 0, resolvedUnpaid: 0, escalated: 0 },
    failed,
  );

  // Housekeeping: leases whose holder died, quotes nobody used, sessions nobody
  // finished. Individually guarded too - none of them is worth losing a tick to.
  await stage("leases", () => expireStaleLeases(), undefined as any, failed);
  await stage("quotes", () => expireStaleQuotes(), 0, failed);
  await stage("sessions", () => expireStaleSessions(), 0, failed);

  // Spent checkout artifacts. Never touches anything that records money moving -
  // see the retention service for exactly where that line is drawn.
  const purged = await stage(
    "retention",
    () => purgeSpentCheckoutArtifacts(),
    { tokenizationSessions: 0, continuationLinks: 0, unusedQuotes: 0 },
    failed,
  );

  return { cycle, dunning, usage, payg, reconciled, purged, failed };
}

/** True when the tick did anything worth a log line. */
export function tickWasEventful(r: TickResult): boolean {
  return Boolean(
    r.cycle.trials || r.cycle.renewals || r.cycle.pending ||
    r.dunning.retried || r.dunning.suspended ||
    r.usage.settled || r.usage.discovered ||
    r.payg.settled ||
    r.reconciled.examined ||
    r.purged.tokenizationSessions || r.purged.continuationLinks || r.purged.unusedQuotes ||
    // A failure is always worth saying out loud, even on an otherwise idle tick.
    r.failed.length,
  );
}
