/**
 * The canonical usage ledger: record first, route second, dispatch third.
 *
 * The invariant this file exists to make violable-and-therefore-testable is:
 *
 *     THE SAME UNIT OF USAGE IS NEVER CHARGED BY TWO PROVIDERS.
 *
 * It is enforced structurally rather than by discipline. `billingSource` is
 * decided ONCE, when the row is written, and the dispatcher only ever sends a
 * row to the source that row already names. There is no code path that asks
 * "who should bill this?" at dispatch time, because a question asked twice can
 * be answered differently twice.
 *
 * The second guard is `idempotencyKey`, unique in the database. A caller that
 * records the same unit twice - a retry, a redelivered job, a double-click -
 * collides on the index and gets the original row back rather than a second
 * one. Shopify enforces its own copy of the same key permanently, so the two
 * defences agree by construction rather than by coincidence.
 *
 * Why recording is separated from dispatching
 * -------------------------------------------
 * Recording is a local database write inside the caller's transaction.
 * Dispatching is a network call to a provider. Doing the second inside the
 * first is the failure the outbox exists to prevent: the transaction can roll
 * back after the provider has already accepted the event, and then we have
 * charged for usage our own records say never happened.
 *
 * So `recordUsage` never talks to anybody, and it is safe to call from
 * anywhere. `dispatchPendingUsage` runs afterwards, outside any transaction,
 * and is the only thing that reaches the network.
 */
import { prisma } from "@chatcenter/shared";
import { Prisma, type BillingSource, type UsageDispatchStatus } from "@prisma/client";
import { getBillingSource } from "../billing-sources";
import { shopifyUsageMeterHandles, shopifyUsageBillingEnabled } from "../billing-sources/shopify/config";

/** Shopify caps its idempotency key at 64 characters, so ours must fit too. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 64;

export class UsageKeyTooLongError extends Error {
  readonly code = "USAGE_IDEMPOTENCY_KEY_TOO_LONG";
  constructor(key: string) {
    super(
      `[usage] idempotency key is ${key.length} characters; the maximum is ${MAX_IDEMPOTENCY_KEY_LENGTH} ` +
        `because Shopify's App Events API rejects anything longer. Refusing to record a unit that could ` +
        `never be dispatched.`,
    );
    this.name = "UsageKeyTooLongError";
  }
}

export interface RecordUsageInput {
  tenantId: string;
  metric: string;
  quantity: number | string;
  occurredAt: Date;
  /**
   * Must be deterministic from the thing being billed - never a timestamp,
   * never a random id. It is the whole double-charge guard, and a key that
   * differs between two attempts at the same unit guards nothing.
   */
  idempotencyKey: string;
  billableEntityId?: string | null;
  providerSubscriptionId?: string | null;
  subscriptionId?: string | null;
  entitlementKey?: string | null;
  /**
   * Who bills for this. Decided by the caller, from the subscription that
   * serves the capability, and frozen onto the row.
   */
  billingSource: BillingSource;
  /** Set to skip dispatch with a stated reason - a cap, a disabled feature. */
  skipReason?: string | null;
}

export interface RecordUsageResult {
  id: string;
  status: UsageDispatchStatus;
  /** True when this key had already been recorded and nothing new was written. */
  duplicate: boolean;
}

/**
 * Write one unit of usage. Never charges, never calls a provider.
 *
 * Returns the EXISTING row on a duplicate key rather than throwing. A caller
 * retrying after a timeout is doing the right thing, and making it handle a
 * unique-constraint error would push the dedupe logic out to every call site -
 * where one of them would eventually get it wrong.
 */
export async function recordUsage(input: RecordUsageInput): Promise<RecordUsageResult> {
  if (input.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new UsageKeyTooLongError(input.idempotencyKey);
  }

  // A row that must not be sent is RECORDED-and-SKIPPED, not absent. The usage
  // genuinely happened and internal reporting needs it; what it must not do is
  // reach a provider.
  const status: UsageDispatchStatus = input.skipReason ? "SKIPPED" : "PENDING";

  try {
    const row = await prisma.usageLedgerEntry.create({
      data: {
        tenantId: input.tenantId,
        billableEntityId: input.billableEntityId ?? null,
        providerSubscriptionId: input.providerSubscriptionId ?? null,
        subscriptionId: input.subscriptionId ?? null,
        entitlementKey: input.entitlementKey ?? null,
        metric: input.metric,
        quantity: new Prisma.Decimal(String(input.quantity)),
        occurredAt: input.occurredAt,
        idempotencyKey: input.idempotencyKey,
        billingSource: input.billingSource,
        status,
        skipReason: input.skipReason ?? null,
      },
      select: { id: true, status: true },
    });
    return { id: row.id, status: row.status, duplicate: false };
  } catch (err: any) {
    if (err?.code !== "P2002") throw err;
    const existing = await prisma.usageLedgerEntry.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true, status: true, billingSource: true },
    });
    if (!existing) throw err;

    // The same unit, previously attributed to a DIFFERENT source. This is the
    // double-billing case caught in the act: two subsystems each believe they
    // own this unit. Loud, and deliberately not silently reconciled - a wrong
    // guess here is money.
    if (existing.billingSource !== input.billingSource) {
      console.error(
        `[usage][conflict] key=${input.idempotencyKey} was recorded for ${existing.billingSource} ` +
          `and is now claimed for ${input.billingSource}. Keeping the original; no second charge.`,
      );
    }
    return { id: existing.id, status: existing.status, duplicate: true };
  }
}

/**
 * Record a correction for a unit already sent.
 *
 * A reversal is a NEW row with a negative quantity and its own idempotency
 * key, never an edit of the original. That is both what an append-only ledger
 * requires and what Shopify's App Events API requires - it accepts a negative
 * `value` under a new key, and has no concept of amending an event.
 */
export async function reverseUsage(input: {
  ledgerEntryId: string;
  idempotencyKey: string;
  occurredAt?: Date;
}): Promise<RecordUsageResult> {
  const original = await prisma.usageLedgerEntry.findUnique({
    where: { id: input.ledgerEntryId },
  });
  if (!original) throw new Error(`[usage] cannot reverse unknown entry ${input.ledgerEntryId}`);

  if (input.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new UsageKeyTooLongError(input.idempotencyKey);
  }

  // Only something that actually reached the provider needs reversing. A
  // PENDING or SKIPPED row is cancelled by never sending it, and issuing a
  // negative for it would hand the provider a credit for a charge it never
  // made.
  const wasDispatched = original.status === "DISPATCHED" || original.status === "ACKED";
  const skipReason = wasDispatched ? null : "original_never_dispatched";

  const created = await recordUsage({
    tenantId: original.tenantId,
    metric: original.metric,
    quantity: original.quantity.negated().toString(),
    occurredAt: input.occurredAt ?? new Date(),
    idempotencyKey: input.idempotencyKey,
    billableEntityId: original.billableEntityId,
    providerSubscriptionId: original.providerSubscriptionId,
    subscriptionId: original.subscriptionId,
    entitlementKey: original.entitlementKey,
    // The reversal follows the original's source. Anything else would credit
    // the wrong provider.
    billingSource: original.billingSource,
    skipReason,
  });

  await prisma.usageLedgerEntry.update({
    where: { id: created.id },
    data: { reversalOfId: original.id },
  });
  await prisma.usageLedgerEntry.update({
    where: { id: original.id },
    data: { status: "REVERSED" },
  });

  return created;
}

/** Exponential backoff, capped. Attempt 1 waits a minute; attempt 8 waits ~2h. */
function nextAttemptAt(attempts: number, now: Date): Date {
  const minutes = Math.min(2 ** Math.max(0, attempts - 1), 128);
  return new Date(now.getTime() + minutes * 60_000);
}

/** Retries stop here. A dead row stays visible rather than disappearing. */
export const MAX_DISPATCH_ATTEMPTS = 8;

export interface DispatchSummary {
  considered: number;
  dispatched: number;
  skipped: number;
  failed: number;
  deadLettered: number;
}

/**
 * Send the usage that is due, to the source each row already names.
 *
 * Runs outside any transaction. Every outcome is written back to the row, so a
 * crash mid-loop leaves a record of what was attempted rather than a silent
 * gap.
 */
export async function dispatchPendingUsage(opts: { now?: Date; limit?: number } = {}): Promise<DispatchSummary> {
  const now = opts.now ?? new Date();
  const summary: DispatchSummary = { considered: 0, dispatched: 0, skipped: 0, failed: 0, deadLettered: 0 };

  const due = await prisma.usageLedgerEntry.findMany({
    where: {
      status: "PENDING",
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: { occurredAt: "asc" },
    take: opts.limit ?? 200,
  });

  for (const entry of due) {
    summary.considered++;
    const source = getBillingSource(entry.billingSource);

    // A source that cannot meter is not a failure to retry. It is a statement
    // that this row was never going to be billed by this route.
    if (!source.dispatchUsage) {
      await markSkipped(entry.id, "source_cannot_meter_usage");
      summary.skipped++;
      continue;
    }

    if (entry.billingSource === "SHOPIFY" && !shopifyUsageBillingEnabled()) {
      await markSkipped(entry.id, "shopify_usage_billing_disabled");
      summary.skipped++;
      continue;
    }

    // The provider's meter handle is configuration and is case-sensitive at
    // Shopify. An unmapped metric is skipped rather than guessed at: inventing
    // a handle would either be rejected or, worse, match a different meter.
    const meterHandle =
      entry.billingSource === "SHOPIFY" ? shopifyUsageMeterHandles()[entry.metric] : entry.metric;
    if (!meterHandle) {
      await markSkipped(entry.id, "no_meter_handle_configured");
      summary.skipped++;
      continue;
    }

    const attempts = entry.attempts + 1;
    try {
      const result = await source.dispatchUsage({
        ledgerEntryId: entry.id,
        tenantId: entry.tenantId,
        meterHandle,
        quantity: entry.quantity.toString(),
        occurredAt: entry.occurredAt,
        idempotencyKey: entry.idempotencyKey,
      });

      if (result.accepted) {
        await prisma.usageLedgerEntry.update({
          where: { id: entry.id },
          data: {
            status: "ACKED",
            attempts,
            providerEventId: result.providerEventId ?? null,
            dispatchedAt: now,
            acknowledgedAt: now,
            failureCode: null,
            failureReason: null,
            nextAttemptAt: null,
          },
        });
        summary.dispatched++;
        continue;
      }

      // Permanent means a retry cannot help - a timestamp outside the billing
      // cycle, a meter that does not exist, the integration switched off.
      // Retrying those forever is noise that hides the real failures.
      if (result.permanent) {
        await prisma.usageLedgerEntry.update({
          where: { id: entry.id },
          data: {
            status: "SKIPPED",
            attempts,
            failureCode: result.failureCode ?? "permanent_rejection",
            failureReason: result.failureReason ?? null,
            skipReason: result.failureCode ?? "permanent_rejection",
            nextAttemptAt: null,
          },
        });
        summary.skipped++;
        continue;
      }

      await recordFailure(entry.id, attempts, now, result.failureCode, result.failureReason, summary);
    } catch (err: any) {
      // A thrown error is a transport problem - a timeout, a socket reset - and
      // says nothing about whether the provider accepted the event. The
      // idempotency key is what makes retrying it safe.
      await recordFailure(entry.id, attempts, now, "dispatch_exception", String(err?.message ?? err), summary);
    }
  }

  return summary;
}

async function markSkipped(id: string, reason: string): Promise<void> {
  await prisma.usageLedgerEntry.update({
    where: { id },
    data: { status: "SKIPPED", skipReason: reason, nextAttemptAt: null },
  });
}

async function recordFailure(
  id: string,
  attempts: number,
  now: Date,
  code: string | null | undefined,
  reason: string | null | undefined,
  summary: DispatchSummary,
): Promise<void> {
  const dead = attempts >= MAX_DISPATCH_ATTEMPTS;
  await prisma.usageLedgerEntry.update({
    where: { id },
    data: {
      // FAILED, not deleted. An exhausted row is a dead letter someone has to
      // look at, and making it disappear would make lost revenue invisible.
      status: dead ? "FAILED" : "PENDING",
      attempts,
      failureCode: code ?? "unknown",
      failureReason: reason ?? null,
      nextAttemptAt: dead ? null : nextAttemptAt(attempts, now),
    },
  });
  if (dead) summary.deadLettered++;
  else summary.failed++;
}

/** What a merchant has used this period, for the usage screen. */
export async function usageTotals(input: {
  tenantId: string;
  since: Date;
  until?: Date;
}): Promise<Record<string, string>> {
  const rows = await prisma.usageLedgerEntry.groupBy({
    by: ["metric"],
    where: {
      tenantId: input.tenantId,
      occurredAt: { gte: input.since, ...(input.until ? { lte: input.until } : {}) },
      // Reversals carry a negative quantity and are summed in, which is what
      // makes the total the NET figure a merchant would recognise.
      status: { not: "SKIPPED" },
    },
    _sum: { quantity: true },
  });
  const out: Record<string, string> = {};
  for (const r of rows) out[r.metric] = (r._sum.quantity ?? new Prisma.Decimal(0)).toString();
  return out;
}
