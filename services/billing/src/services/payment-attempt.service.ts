/**
 * Payment attempts: the double-charge guard.
 *
 * iCount has confirmed no provider-side idempotency mechanism, so nothing on
 * their end will reject a duplicate `cc/bill`. GOTCHA's own uniqueness is the
 * only thing standing between a retry and a second charge, which makes this
 * file load-bearing rather than bookkeeping.
 *
 * TWO separate guarantees are needed, and the unique index only provides the
 * first:
 *
 *   Uniqueness stops two ROWS existing for one logical charge. It is a
 *   PostgreSQL constraint, so it holds across every billing instance.
 *
 *   Ownership stops two WORKERS executing that one row. Uniqueness alone does
 *   not give this: two instances can both find the same existing row and both
 *   decide to charge it. That is what `claimExecution` is for, and it is the
 *   actual money-safety boundary. A scheduler leader lock is an optimisation
 *   that reduces duplicate scanning; it must never be the only protection.
 *
 * The rules, in order of importance:
 *
 *   1. One row per LOGICAL charge, keyed by `attemptKey`. Creating a second is
 *      a database conflict, not a second call to the provider.
 *   1b. Exactly one worker may hold a time-bounded execution lease on that row,
 *      taken with a single atomic conditional UPDATE. Losers exit without
 *      calling the provider.
 *   2. A charge whose outcome is unknown (timeout, crash between request and
 *      response) becomes UNKNOWN - never FAILED. FAILED means "the provider
 *      told us no"; UNKNOWN means "we do not know", and treating the second as
 *      the first is how you charge someone twice.
 *   3. UNKNOWN is NEVER automatically retried. It must be reconciled against
 *      the provider first.
 *   4. Reconciliation that cannot decide - several equally plausible candidate
 *      transactions - becomes MANUAL_REVIEW. A human decides; the system does
 *      not guess with someone's money.
 */
import { prisma } from "@chatcenter/shared";
import type { PaymentAttemptState } from "@prisma/client";
import type { ChargeInput, ChargeResult, PaymentProvider } from "../providers/provider";
import { assertChargeCurrency, type ProviderCapabilities } from "../providers/capabilities";

export type AttemptPurpose =
  | "SUBSCRIPTION_INITIAL"
  | "RENEWAL"
  | "CREDIT_PURCHASE"
  | "AUTO_TOPUP";

export interface QuoteBinding {
  paymentQuoteId: string;
  chargeAmount: string;
  chargeCurrency: string;
  providerCurrencyId: number;
}

export interface BeginAttemptInput {
  attemptKey: string;
  purpose: AttemptPurpose;
  amount: number;
  currency: string;
  tenantId?: string | null;
  checkoutId?: string | null;
  /** The frozen conversion this charge will submit. */
  quote?: QuoteBinding;
}

export interface AttemptRecord {
  id: string;
  attemptKey: string;
  state: PaymentAttemptState;
  providerChargeRef: string | null;
  failureCode: string | null;
}

/** Errors that mean "we do not know what happened", as opposed to a decline. */
function isAmbiguousFailure(err: unknown): boolean {
  const e = err as any;
  // A provider that already worked out its outcome was ambiguous says so
  // explicitly. Relying on message sniffing alone would silently downgrade
  // those to FAILED, which is the one mistake this whole file exists to avoid.
  if (e?.outcomeUnknown === true) return true;
  const code = String(e?.code ?? "");
  const msg = String(e?.message ?? "");
  return (
    code === "ECONNABORTED" || // axios timeout
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    /timeout|timed out|socket hang up|network/i.test(msg)
  );
}

/**
 * Claim the right to make exactly one charge.
 *
 * Returns `{ created: false }` when this logical charge has already been
 * attempted - the caller must NOT charge again, whatever the existing state
 * says. An already-existing UNKNOWN in particular is a reason to reconcile, not
 * a reason to try once more.
 */
export async function beginAttempt(
  input: BeginAttemptInput,
): Promise<{ created: boolean; attempt: AttemptRecord }> {
  try {
    const attempt = await prisma.paymentAttempt.create({
      data: {
        attemptKey: input.attemptKey,
        purpose: input.purpose,
        amount: input.amount,
        currency: input.currency,
        tenantId: input.tenantId ?? null,
        checkoutId: input.checkoutId ?? null,
        state: "PENDING",
        // Recorded at creation, not at success: if the process dies mid-charge,
        // the row still says what was going to be submitted, which is what
        // reconciliation needs to look for.
        paymentQuoteId: input.quote?.paymentQuoteId ?? null,
        chargeAmount: input.quote?.chargeAmount ?? null,
        chargeCurrency: input.quote?.chargeCurrency ?? null,
        providerCurrencyId: input.quote?.providerCurrencyId ?? null,
      },
      select: { id: true, attemptKey: true, state: true, providerChargeRef: true, failureCode: true },
    });
    return { created: true, attempt };
  } catch (err: any) {
    // P2002 = unique violation on attemptKey. Someone already claimed this
    // charge; surfacing the existing row is the whole point of the constraint.
    if (err?.code !== "P2002") throw err;
    const existing = await prisma.paymentAttempt.findUnique({
      where: { attemptKey: input.attemptKey },
      select: { id: true, attemptKey: true, state: true, providerChargeRef: true, failureCode: true },
    });
    if (!existing) throw err; // vanished between insert and read - genuinely exceptional
    return { created: false, attempt: existing };
  }
}

/**
 * Execute a claimed attempt exactly once.
 *
 * Never called for an attempt that already exists in any state: `beginAttempt`
 * decides that, and this function assumes the claim was fresh.
 */
export async function runAttempt(args: {
  attemptId: string;
  provider: PaymentProvider;
  capabilities: ProviderCapabilities;
  charge: ChargeInput;
  // `failureCode` is returned as well as persisted: a caller needs the decline
  // reason to tell the customer what happened, and re-reading the row to find
  // out is an easy step to forget.
}): Promise<{ state: PaymentAttemptState; result?: ChargeResult; failureCode?: string }> {
  // Refuse before any network call if the currency contract is unverified for
  // what will actually be SUBMITTED. Checking `currency` here would be wrong
  // now that the two differ: the customer agrees USD and the provider is sent
  // ILS, so checking the commercial currency would refuse every USD plan while
  // saying nothing about the charge itself.
  try {
    assertChargeCurrency(args.capabilities, args.charge.chargeCurrency ?? args.charge.currency);
  } catch (err: any) {
    await setState(args.attemptId, "FAILED", { failureCode: err.message });
    return { state: "FAILED", failureCode: err.message };
  }

  let result: ChargeResult;
  try {
    result = await args.provider.charge(args.charge);
  } catch (err) {
    if (isAmbiguousFailure(err)) {
      // We may or may not have charged. Do not guess, do not retry.
      const code = "ambiguous_outcome: provider did not answer";
      await setState(args.attemptId, "UNKNOWN", { failureCode: code });
      return { state: "UNKNOWN", failureCode: code };
    }
    const code = (err as any)?.message ?? "charge_failed";
    await setState(args.attemptId, "FAILED", { failureCode: code });
    return { state: "FAILED", failureCode: code };
  }

  if (result.success) {
    await setState(args.attemptId, "SUCCEEDED", { providerChargeRef: result.providerChargeRef });
    return { state: "SUCCEEDED", result };
  }
  if (result.requiresReconciliation) {
    // The provider took the charge but gave us nothing to identify it with.
    // FAILED would invite a retry, and a retry here charges a second time.
    await setState(args.attemptId, "RECONCILIATION_REQUIRED", { failureCode: result.failureCode });
    return { state: "RECONCILIATION_REQUIRED", result, failureCode: result.failureCode };
  }
  await setState(args.attemptId, "FAILED", { failureCode: result.failureCode });
  return { state: "FAILED", result, failureCode: result.failureCode };
}

/**
 * Resolve an UNKNOWN attempt by asking the provider what actually happened.
 *
 * Outcomes:
 *   exactly one matching transaction  -> SUCCEEDED, reference recorded
 *   no matching transaction           -> FAILED, safe to charge again
 *   more than one equal candidate     -> MANUAL_REVIEW, a human decides
 *
 * Deliberately conservative: without a merchant reference on the transaction
 * (iCount confirms none), matching is by amount and card token, which cannot
 * distinguish two identical legitimate charges. That ambiguity is escalated
 * rather than resolved by picking one.
 */
export async function reconcileUnknown(args: {
  attemptId: string;
  provider: PaymentProvider;
  token?: string;
  clientId?: string;
}): Promise<{ state: PaymentAttemptState; candidates: number }> {
  const attempt = await prisma.paymentAttempt.findUnique({ where: { id: args.attemptId } });
  if (!attempt) throw new Error("attempt_not_found");
  if (!requiresReconciliation(attempt.state)) {
    return { state: attempt.state, candidates: attempt.candidateCount ?? 0 };
  }

  if (!args.provider.lookupTransactions) {
    // No lookup capability: we can never learn the truth automatically.
    await setState(args.attemptId, "MANUAL_REVIEW", {
      reviewReason: "provider has no transaction lookup",
      reconciledAt: new Date(),
    });
    return { state: "MANUAL_REVIEW", candidates: 0 };
  }

  const raw: any = await args.provider.lookupTransactions({
    token: args.token,
    clientId: args.clientId,
  });
  const all: any[] = Array.isArray(raw?.transactions)
    ? raw.transactions
    : Array.isArray(raw)
      ? raw
      : [];

  const wanted = Number(attempt.amount);
  const candidates = all.filter((t) => Number(t?.sum ?? t?.amount) === wanted);

  if (candidates.length === 1) {
    const t = candidates[0];
    await setState(args.attemptId, "SUCCEEDED", {
      providerChargeRef: t?.confirmation_code || t?.deal_id || t?.txn_id || null,
      candidateCount: 1,
      reconciledAt: new Date(),
    });
    return { state: "SUCCEEDED", candidates: 1 };
  }

  if (candidates.length === 0) {
    await setState(args.attemptId, "FAILED", {
      failureCode: "reconciled: no matching transaction at the provider",
      candidateCount: 0,
      reconciledAt: new Date(),
    });
    return { state: "FAILED", candidates: 0 };
  }

  await setState(args.attemptId, "MANUAL_REVIEW", {
    reviewReason: `ambiguous: ${candidates.length} transactions match this amount`,
    candidateCount: candidates.length,
    reconciledAt: new Date(),
  });
  return { state: "MANUAL_REVIEW", candidates: candidates.length };
}

/**
 * Whether a purpose may be attempted again.
 *
 * UNKNOWN and MANUAL_REVIEW are terminal for automation: both mean a charge
 * might already exist. Only an outcome the provider explicitly refused is
 * safe to repeat.
 */
export function mayRetry(state: PaymentAttemptState): boolean {
  return state === "FAILED";
}

/** States that forbid a new provider call until reconciliation resolves them. */
export function requiresReconciliation(state: PaymentAttemptState): boolean {
  return state === "UNKNOWN" || state === "RECONCILIATION_REQUIRED";
}

async function setState(
  id: string,
  state: PaymentAttemptState,
  extra: {
    providerChargeRef?: string | null;
    failureCode?: string | null;
    reviewReason?: string;
    candidateCount?: number;
    reconciledAt?: Date;
  } = {},
): Promise<void> {
  await prisma.paymentAttempt.update({ where: { id }, data: { state, ...extra } });
}

// ── Cross-instance execution ownership ──────────────────────────────────────

/** How long a worker may hold an execution lease before it is considered dead. */
export const DEFAULT_LEASE_MS = 120_000;

/** States a worker may take ownership of. */
const CLAIMABLE_STATES = ["PENDING", "FAILED"] as const;

/**
 * Take exclusive ownership of an attempt, atomically.
 *
 * ONE conditional UPDATE. Not read-then-write: reading first and updating after
 * leaves a window in which two workers both read "unowned" and both proceed.
 * Postgres row-locks the matching row, so of N concurrent callers exactly one
 * sees count === 1 and the rest see 0.
 *
 * The `providerRequestStartedAt: null` condition is the important one. It means
 * a lease can only ever be taken when NO provider request has been submitted
 * for this attempt. An attempt whose previous owner died mid-flight is
 * therefore unclaimable here by construction, and must go through
 * reconciliation instead - see expireStaleLeases().
 */
export async function claimExecution(args: {
  attemptId: string;
  owner: string;
  leaseMs?: number;
  now?: Date;
}): Promise<{ claimed: boolean }> {
  const now = args.now ?? new Date();
  const leaseMs = args.leaseMs ?? DEFAULT_LEASE_MS;

  const res = await prisma.paymentAttempt.updateMany({
    where: {
      id: args.attemptId,
      state: { in: [...CLAIMABLE_STATES] },
      // Never reclaim something that may already have been submitted.
      providerRequestStartedAt: null,
      OR: [
        { executionOwner: null },
        { executionLeaseExpiresAt: null },
        { executionLeaseExpiresAt: { lt: now } },
      ],
    },
    data: {
      executionOwner: args.owner,
      executionLeaseExpiresAt: new Date(now.getTime() + leaseMs),
      executionStartedAt: now,
      lastHeartbeatAt: now,
      attemptNumber: { increment: 1 },
      state: "PENDING",
    },
  });

  return { claimed: res.count === 1 };
}

/**
 * Record that a provider request is about to be sent.
 *
 * Written BEFORE the call, deliberately. If this write succeeds and the process
 * then dies, the attempt is permanently unclaimable and must be reconciled -
 * which is the correct, conservative outcome. Writing it after the call would
 * leave a window where a crash looks like "never submitted".
 *
 * Scoped to the lease holder: a worker whose lease expired cannot mark a
 * request as started.
 */
export async function markProviderRequestStarted(args: {
  attemptId: string;
  owner: string;
  now?: Date;
}): Promise<boolean> {
  const now = args.now ?? new Date();
  const res = await prisma.paymentAttempt.updateMany({
    where: {
      id: args.attemptId,
      executionOwner: args.owner,
      executionLeaseExpiresAt: { gt: now },
      providerRequestStartedAt: null,
    },
    data: { providerRequestStartedAt: now, lastHeartbeatAt: now },
  });
  return res.count === 1;
}

/** Record that the provider answered, whatever the answer was. */
export async function markProviderResponseReceived(args: {
  attemptId: string;
  owner: string;
  now?: Date;
}): Promise<void> {
  const now = args.now ?? new Date();
  await prisma.paymentAttempt.updateMany({
    where: { id: args.attemptId, executionOwner: args.owner },
    data: { providerResponseReceivedAt: now, lastHeartbeatAt: now },
  });
}

/** Extend a lease during a long provider call. */
export async function heartbeat(args: {
  attemptId: string;
  owner: string;
  leaseMs?: number;
  now?: Date;
}): Promise<boolean> {
  const now = args.now ?? new Date();
  const res = await prisma.paymentAttempt.updateMany({
    where: { id: args.attemptId, executionOwner: args.owner, executionLeaseExpiresAt: { gt: now } },
    data: {
      lastHeartbeatAt: now,
      executionLeaseExpiresAt: new Date(now.getTime() + (args.leaseMs ?? DEFAULT_LEASE_MS)),
    },
  });
  return res.count === 1;
}

/** Give up ownership without changing the outcome. */
export async function releaseExecution(args: { attemptId: string; owner: string }): Promise<void> {
  await prisma.paymentAttempt.updateMany({
    where: { id: args.attemptId, executionOwner: args.owner },
    data: { executionOwner: null, executionLeaseExpiresAt: null },
  });
}

/**
 * Sweep leases whose holder died.
 *
 * The distinction that matters, and the reason this is not a single query:
 *
 *   Expired BEFORE submission (providerRequestStartedAt IS NULL)
 *     No provider request was ever sent. There is proof no charge exists, so
 *     the attempt is simply released and another worker may claim it.
 *
 *   Expired AFTER submission may have started (providerRequestStartedAt set,
 *   providerResponseReceivedAt NULL)
 *     A charge may exist at the provider and we will never know from local
 *     state. Moving it to RECONCILIATION_REQUIRED forbids another cc/bill;
 *     it must be resolved against cc/transactions, and escalated to
 *     MANUAL_REVIEW if that cannot decide.
 *
 * Reclaiming the second case for a fresh charge is precisely how a customer
 * gets billed twice, so it is never done automatically.
 */
export async function expireStaleLeases(now: Date = new Date()): Promise<{
  released: number;
  needsReconciliation: number;
}> {
  const released = await prisma.paymentAttempt.updateMany({
    where: {
      executionLeaseExpiresAt: { lt: now },
      executionOwner: { not: null },
      providerRequestStartedAt: null, // proof: nothing was submitted
      state: { in: [...CLAIMABLE_STATES] },
    },
    data: { executionOwner: null, executionLeaseExpiresAt: null },
  });

  const needsReconciliation = await prisma.paymentAttempt.updateMany({
    where: {
      executionLeaseExpiresAt: { lt: now },
      executionOwner: { not: null },
      providerRequestStartedAt: { not: null },
      providerResponseReceivedAt: null,
      state: { in: ["PENDING"] },
    },
    data: {
      state: "RECONCILIATION_REQUIRED",
      executionOwner: null,
      executionLeaseExpiresAt: null,
      failureCode: "lease_expired_after_submission: outcome unknown, reconcile before any retry",
    },
  });

  return { released: released.count, needsReconciliation: needsReconciliation.count };
}
