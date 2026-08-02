/**
 * AI-Unit wallet - append-only ledger + lot model.
 *
 *   • INCLUDED  units: the monthly plan allotment. Expire at renewal
 *                      (use-it-or-lose-it). One lot per billing period.
 *   • PURCHASED units: bought or auto-purchased. Never expire. Consumed
 *                      oldest-first (FIFO) AFTER the current INCLUDED lot.
 *
 * Balance = Σ ledger, reconcilable against AiUnitLot.unitsRemaining. A fast
 * materialized snapshot (TenantAiBalance) backs the hot-path runtime gate.
 *
 * Invariant: balance is NEVER negative. A consume that would overspend is
 * clamped; the caller's pre-flight gate is responsible for refusing the turn.
 */
import { prisma } from "../prisma";
import type { AiUnitBucket, AiUnitGrantType } from "@prisma/client";

// Full client (has `$transaction`) for top-level atomic entrypoints.
type FullClient = typeof prisma;
// The handle an interactive `$transaction` callback receives: the same extended
// client minus the connection/extension helpers. Derived from the real client
// type so it stays correct with the tenant-guard Prisma extension applied.
type Tx = Omit<FullClient, "$connect" | "$disconnect" | "$on" | "$use" | "$extends" | "$transaction">;

export interface BalanceView {
  includedRemaining: number;
  purchasedRemaining: number;
  includedAllowance: number;
  total: number;
  periodKey: string | null;
}

const THRESHOLDS = [80, 90, 95, 100] as const;
export type UsageThreshold = (typeof THRESHOLDS)[number];

function dec(v: unknown, fallback = 0): number {
  if (v == null) return fallback;
  const n = typeof v === "object" && "toNumber" in (v as any) ? (v as any).toNumber() : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ── Pure helpers (DB-free, unit-tested) ─────────────────────────────────────

/**
 * Which consumed-percentage thresholds were newly crossed moving from
 * `remainingBefore` → `remainingAfter` against `allowance`. Allowance is the
 * monthly INCLUDED grant; total balance (incl. purchased) is used as the
 * numerator so buying more Units legitimately lowers the consumed %.
 */
export function crossedThresholds(
  allowance: number,
  totalBefore: number,
  totalAfter: number,
): UsageThreshold[] {
  if (allowance <= 0) return [];
  const consumedPct = (remaining: number) => Math.min(100, Math.max(0, (1 - remaining / allowance) * 100));
  const before = consumedPct(totalBefore);
  const after = consumedPct(totalAfter);
  return THRESHOLDS.filter((t) => before < t && after >= t);
}

/** Split a consume across INCLUDED-first then PURCHASED FIFO. Pure planner. */
export function planConsumption(
  units: number,
  lots: Array<{ id: string; bucket: AiUnitBucket; unitsRemaining: number }>,
): { debits: Array<{ lotId: string; bucket: AiUnitBucket; amount: number }>; consumed: number; shortfall: number } {
  let remaining = units;
  const debits: Array<{ lotId: string; bucket: AiUnitBucket; amount: number }> = [];
  // lots arrive already ordered: INCLUDED(current) first, then PURCHASED oldest-first.
  for (const lot of lots) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, lot.unitsRemaining);
    if (take > 0) {
      debits.push({ lotId: lot.id, bucket: lot.bucket, amount: take });
      remaining -= take;
    }
  }
  return { debits, consumed: units - remaining, shortfall: Math.max(0, remaining) };
}

// ── DB-backed wallet ops ────────────────────────────────────────────────────

/** Fast read of the materialized snapshot (hot path). */
export async function getBalance(tenantId: string, client: Tx = prisma): Promise<BalanceView> {
  const snap = await client.tenantAiBalance.findUnique({ where: { tenantId } });
  if (!snap) return { includedRemaining: 0, purchasedRemaining: 0, includedAllowance: 0, total: 0, periodKey: null };
  const inc = dec(snap.includedRemaining);
  const pur = dec(snap.purchasedRemaining);
  return {
    includedRemaining: inc,
    purchasedRemaining: pur,
    includedAllowance: dec(snap.includedAllowance),
    total: inc + pur,
    periodKey: snap.periodKey ?? null,
  };
}

/** Authoritative balance derived from lots (reconciliation / recompute). */
export async function deriveBalanceFromLots(
  tenantId: string,
  currentPeriodKey: string | null,
  client: Tx = prisma,
): Promise<{ includedRemaining: number; purchasedRemaining: number }> {
  const lots = await client.aiUnitLot.findMany({ where: { tenantId } });
  let included = 0;
  let purchased = 0;
  for (const lot of lots) {
    const rem = dec(lot.unitsRemaining);
    if (lot.bucket === "INCLUDED") {
      if (currentPeriodKey && lot.periodKey === currentPeriodKey) included += rem;
    } else {
      purchased += rem;
    }
  }
  return { includedRemaining: included, purchasedRemaining: purchased };
}

async function refreshSnapshot(
  tenantId: string,
  periodKey: string | null,
  includedAllowance: number | undefined,
  client: Tx,
): Promise<void> {
  // A PURCHASED grant carries no periodKey. Without this fallback we'd derive
  // the INCLUDED balance against a null period - counting ZERO included lots and
  // wiping the tenant's remaining monthly allowance from the snapshot. Preserve
  // the current period (and allowance) from the existing snapshot when the
  // caller didn't supply one, so a purchase only ADDS purchased units.
  const existing = await client.tenantAiBalance.findUnique({ where: { tenantId } });
  const effectivePeriodKey = periodKey ?? existing?.periodKey ?? null;
  const { includedRemaining, purchasedRemaining } = await deriveBalanceFromLots(tenantId, effectivePeriodKey, client);
  await client.tenantAiBalance.upsert({
    where: { tenantId },
    create: {
      tenantId,
      includedRemaining: includedRemaining.toFixed(6),
      purchasedRemaining: purchasedRemaining.toFixed(6),
      includedAllowance: (includedAllowance ?? 0).toFixed(6),
      periodKey: effectivePeriodKey,
    },
    update: {
      includedRemaining: includedRemaining.toFixed(6),
      purchasedRemaining: purchasedRemaining.toFixed(6),
      ...(includedAllowance != null ? { includedAllowance: includedAllowance.toFixed(6) } : {}),
      periodKey: effectivePeriodKey,
    },
  });
}

export interface GrantInput {
  tenantId: string;
  bucket: AiUnitBucket;
  grantType: AiUnitGrantType;
  units: number;
  periodKey?: string | null;
  expiresAt?: Date | null;
  source?: string;
  referenceId?: string;
  /** For INCLUDED grants, also set the snapshot's allowance for %-calcs. */
  includedAllowance?: number;
}

/** Grant Units within an existing transaction (lot + GRANT ledger + snapshot). */
export async function grantUnitsInTx(tx: Tx, input: GrantInput): Promise<{ lotId: string }> {
  const lot = await tx.aiUnitLot.create({
    data: {
      tenantId: input.tenantId,
      bucket: input.bucket,
      grantType: input.grantType,
      unitsGranted: input.units.toFixed(6),
      unitsRemaining: input.units.toFixed(6),
      periodKey: input.periodKey ?? null,
      expiresAt: input.expiresAt ?? null,
      source: input.source,
      referenceId: input.referenceId,
    },
  });
  await tx.aiUnitLedgerEntry.create({
    data: {
      tenantId: input.tenantId,
      lotId: lot.id,
      entryType: "GRANT",
      bucket: input.bucket,
      units: input.units.toFixed(6),
      periodKey: input.periodKey ?? null,
      source: input.source,
      referenceId: input.referenceId,
    },
  });
  await refreshSnapshot(input.tenantId, input.periodKey ?? null, input.includedAllowance, tx);
  return { lotId: lot.id };
}

/** Grant Units atomically (opens its own transaction). */
export async function grantUnits(input: GrantInput, client: FullClient = prisma): Promise<{ lotId: string }> {
  return client.$transaction((tx) => grantUnitsInTx(tx, input));
}

export interface ConsumeResult {
  consumed: number;
  shortfall: number;
  thresholds: UsageThreshold[];
  totalAfter: number;
}

/**
 * Consume Units (INCLUDED current-period first, then PURCHASED FIFO). Never
 * drives a lot or the snapshot negative. Returns crossed thresholds so the
 * caller can emit notifications / trigger auto-purchase.
 */
export async function consumeUnits(
  tenantId: string,
  units: number,
  opts: { periodKey?: string | null; referenceId?: string; source?: string } = {},
  client: FullClient = prisma,
): Promise<ConsumeResult> {
  if (units <= 0) {
    const b = await getBalance(tenantId, client);
    return { consumed: 0, shortfall: 0, thresholds: [], totalAfter: b.total };
  }
  return client.$transaction(async (tx) => {
    const periodKey = opts.periodKey ?? null;
    const before = await getBalance(tenantId, tx);
    const allowance = before.includedAllowance;

    // Ordered lots: INCLUDED current period (oldest first), then PURCHASED FIFO.
    const includedLots = await tx.aiUnitLot.findMany({
      where: { tenantId, bucket: "INCLUDED", ...(periodKey ? { periodKey } : {}), unitsRemaining: { gt: 0 } },
      orderBy: { createdAt: "asc" },
    });
    const purchasedLots = await tx.aiUnitLot.findMany({
      where: { tenantId, bucket: "PURCHASED", unitsRemaining: { gt: 0 } },
      orderBy: { createdAt: "asc" },
    });
    const ordered = [...includedLots, ...purchasedLots].map((l) => ({
      id: l.id,
      bucket: l.bucket,
      unitsRemaining: dec(l.unitsRemaining),
    }));

    const plan = planConsumption(units, ordered);
    for (const d of plan.debits) {
      await tx.aiUnitLot.update({
        where: { id: d.lotId },
        data: { unitsRemaining: { decrement: d.amount.toFixed(6) as any } },
      });
      await tx.aiUnitLedgerEntry.create({
        data: {
          tenantId,
          lotId: d.lotId,
          entryType: "CONSUME",
          bucket: d.bucket,
          units: (-d.amount).toFixed(6),
          periodKey,
          source: opts.source ?? "ai_usage",
          referenceId: opts.referenceId,
        },
      });
    }
    await refreshSnapshot(tenantId, periodKey ?? before.periodKey, undefined, tx);
    const after = await getBalance(tenantId, tx);
    return {
      consumed: plan.consumed,
      shortfall: plan.shortfall,
      thresholds: crossedThresholds(allowance, before.total, after.total),
      totalAfter: after.total,
    };
  });
}

/**
 * Expire the prior period's INCLUDED lots and grant the new period's allowance.
 * Purchased lots are untouched. Called by the renewal job.
 *
 * `replaceCurrentPeriod` also expires the CURRENT period's lots before granting.
 * A renewal must not do that - it runs once per period and the current period's
 * allowance is the one being replaced by a later one. Re-provisioning does: an
 * operator who fixes a POC's credit budget from 5,000 to 2,000 and runs it again
 * means the budget IS 2,000, and without this the second grant lands in the same
 * period alongside the first, leaving 7,000. That is not a rounding difference,
 * it is the allowance being decided by how many times someone pressed a button.
 */
export async function rolloverIncluded(
  tenantId: string,
  newPeriodKey: string,
  newAllowance: number,
  expiresAt: Date,
  source: string,
  client: FullClient = prisma,
  opts: { replaceCurrentPeriod?: boolean } = {},
): Promise<void> {
  await client.$transaction(async (tx) => {
    const stale = await tx.aiUnitLot.findMany({
      where: {
        tenantId,
        bucket: "INCLUDED",
        ...(opts.replaceCurrentPeriod ? {} : { periodKey: { not: newPeriodKey } }),
        unitsRemaining: { gt: 0 },
      },
    });
    for (const lot of stale) {
      const rem = dec(lot.unitsRemaining);
      await tx.aiUnitLot.update({ where: { id: lot.id }, data: { unitsRemaining: "0" } });
      await tx.aiUnitLedgerEntry.create({
        data: { tenantId, lotId: lot.id, entryType: "EXPIRE", bucket: "INCLUDED", units: (-rem).toFixed(6), periodKey: lot.periodKey, source: "period_reset" },
      });
    }
    await grantUnitsInTx(tx, {
      tenantId, bucket: "INCLUDED", grantType: "PLAN", units: newAllowance, periodKey: newPeriodKey, expiresAt, source, includedAllowance: newAllowance,
    });
  });
}

/**
 * Expire any lot whose `expiresAt` has passed, in ANY bucket.
 *
 * `rolloverIncluded` only expires the previous period's INCLUDED lots. Purchased
 * credits default to never expiring, but a credit package may configure
 * DAYS_AFTER_PURCHASE or PERIOD_END, and trial/POC grants always carry an
 * expiry - this is the sweep that honours them. Writes an EXPIRE ledger entry
 * per lot so an expiring balance is auditable rather than a silent decrement.
 *
 * Idempotent: a lot already at zero remaining is skipped.
 */
export async function expireDueLots(
  now = new Date(),
  opts: { tenantId?: string } = {},
  client: FullClient = prisma,
): Promise<{ expiredLots: number; expiredUnits: number }> {
  const due = await client.aiUnitLot.findMany({
    where: {
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
      expiresAt: { not: null, lte: now },
      unitsRemaining: { gt: 0 },
    },
    take: 500,
  });
  let expiredUnits = 0;
  for (const lot of due) {
    const rem = dec(lot.unitsRemaining);
    if (rem <= 0) continue;
    await client.$transaction(async (tx) => {
      await tx.aiUnitLot.update({ where: { id: lot.id }, data: { unitsRemaining: "0" } });
      await tx.aiUnitLedgerEntry.create({
        data: {
          tenantId: lot.tenantId,
          lotId: lot.id,
          entryType: "EXPIRE",
          bucket: lot.bucket,
          units: (-rem).toFixed(6),
          periodKey: lot.periodKey,
          source: "lot_expiry",
          referenceId: lot.referenceId,
        },
      });
      await refreshSnapshot(lot.tenantId, lot.periodKey, undefined, tx);
    });
    expiredUnits += rem;
  }
  return { expiredLots: due.length, expiredUnits };
}

/**
 * Claw back PURCHASED units from a refunded/charged-back purchase. Reduces the
 * lots granted under `referenceId` (the purchase invoice id) by whatever is
 * still REMAINING - already-consumed units cannot be un-spent, and balance never
 * goes negative. Writes a REFUND ledger entry per lot for auditability. Returns
 * the total units reclaimed.
 */
export async function refundUnitsForReference(
  tenantId: string,
  referenceId: string,
  reason: string,
  client: FullClient = prisma,
): Promise<{ reclaimed: number }> {
  return client.$transaction(async (tx) => {
    const lots = await tx.aiUnitLot.findMany({ where: { tenantId, referenceId, unitsRemaining: { gt: 0 } } });
    let reclaimed = 0;
    let periodKey: string | null = null;
    for (const lot of lots) {
      const rem = dec(lot.unitsRemaining);
      if (rem <= 0) continue;
      await tx.aiUnitLot.update({ where: { id: lot.id }, data: { unitsRemaining: "0" } });
      await tx.aiUnitLedgerEntry.create({
        data: { tenantId, lotId: lot.id, entryType: "REFUND", bucket: lot.bucket, units: (-rem).toFixed(6), periodKey: lot.periodKey, source: reason, referenceId },
      });
      reclaimed += rem;
      periodKey = lot.periodKey ?? periodKey;
    }
    if (reclaimed > 0) await refreshSnapshot(tenantId, periodKey, undefined, tx);
    return { reclaimed };
  });
}
