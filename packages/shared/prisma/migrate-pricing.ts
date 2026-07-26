/**
 * Pricing migration and compatibility.
 *
 *   npm run db:migrate-pricing            (from packages/shared)
 *   npm run db:migrate-pricing -- --apply (write; default is a DRY RUN)
 *
 * Brings pre-existing billing data onto the new pricing domain WITHOUT changing
 * anyone's commercial terms. What it does, in order:
 *
 *   1. Re-labels legacy plans as LEGACY/RETIRED. Their price, currency,
 *      included credits and entitlements are untouched, and no subscription is
 *      repointed - a customer on `pro` stays on `pro` at `pro`'s price.
 *   2. Backfills the commercial snapshot on every subscription that lacks one,
 *      FROM ITS OWN PLAN VERSION. This is the important step: without a
 *      snapshot, the next renewal would read the live plan row, so a future plan
 *      edit would silently reprice existing customers. Backfilling freezes them
 *      where they already are.
 *   3. Creates a private legacy PlanVersion for any subscription pointing at a
 *      plan row that no longer exists, so no organization is left dangling.
 *   4. Reports anything it could not map, rather than guessing.
 *
 * Safety properties:
 *   • DRY RUN by default. Nothing is written without --apply.
 *   • Idempotent - a second run makes no further changes.
 *   • Never writes to the credit ledger, an invoice, or a charge.
 *   • Never downgrades an organization or removes an entitlement.
 *   • Partial execution is safe: each step is independently re-runnable.
 */
import { PrismaClient } from "@prisma/client";
import { LEGACY_PLAN_KEYS } from "../src/lib/billing/plan-seeds";

const prisma = new PrismaClient();

export interface MigrationReport {
  dryRun: boolean;
  legacyPlansRelabelled: number;
  subscriptionsInspected: number;
  snapshotsBackfilled: number;
  snapshotsAlreadyPresent: number;
  legacyPlanVersionsCreated: string[];
  unmappedSubscriptions: Array<{ subscriptionId: string; planKey: string; planVersion: number; reason: string }>;
  warnings: string[];
}

export async function migratePricing(
  db: PrismaClient,
  opts: { apply?: boolean } = {},
): Promise<MigrationReport> {
  const apply = Boolean(opts.apply);
  const report: MigrationReport = {
    dryRun: !apply,
    legacyPlansRelabelled: 0,
    subscriptionsInspected: 0,
    snapshotsBackfilled: 0,
    snapshotsAlreadyPresent: 0,
    legacyPlanVersionsCreated: [],
    unmappedSubscriptions: [],
    warnings: [],
  };

  // ── 1) Re-label legacy catalog rows ──────────────────────────────────────
  // Only the labels change. basePrice, currency, includedAiUnits and every
  // PlanEntitlement row are left exactly as they are.
  const legacy = await db.plan.findMany({
    where: { key: { in: LEGACY_PLAN_KEYS }, NOT: { kind: "LEGACY" } },
    select: { id: true, key: true, version: true },
  });
  report.legacyPlansRelabelled = legacy.length;
  if (apply && legacy.length) {
    await db.plan.updateMany({
      where: { id: { in: legacy.map((p) => p.id) } },
      data: { kind: "LEGACY", status: "RETIRED", sortOrder: 900 },
    });
  }

  // ── 2) Backfill the commercial snapshot ──────────────────────────────────
  const subscriptions = await db.subscription.findMany({
    select: {
      id: true, planKey: true, planVersion: true, snapshotAt: true,
      chatVolumeOptionKey: true, voiceVolumeOptionKey: true, billableEntityId: true,
    },
  });
  report.subscriptionsInspected = subscriptions.length;

  const globalEstimation = await db.publicEstimationConfig.findFirst({
    where: { scope: "GLOBAL", active: true },
    orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
  });

  for (const sub of subscriptions) {
    if (sub.snapshotAt) {
      report.snapshotsAlreadyPresent++;
      continue;
    }

    // Read the subscription's OWN pinned version, never the newest one.
    let plan = await db.plan.findUnique({
      where: { key_version: { key: sub.planKey, version: sub.planVersion } },
      include: { estimations: { where: { active: true }, orderBy: { effectiveFrom: "desc" }, take: 1 } },
    });

    // ── 3) Dangling reference → private legacy PlanVersion ─────────────────
    if (!plan) {
      const anyVersion = await db.plan.findFirst({ where: { key: sub.planKey }, orderBy: { version: "desc" } });
      if (!anyVersion) {
        report.unmappedSubscriptions.push({
          subscriptionId: sub.id, planKey: sub.planKey, planVersion: sub.planVersion,
          reason: "no plan row exists for this key at any version",
        });
        continue;
      }
      // Recreate the exact (key, version) the subscription points at, cloned
      // from the nearest surviving version. Private and retired: it exists to
      // keep an organization's history intact, not to be sold.
      const label = `${sub.planKey}@${sub.planVersion}`;
      report.legacyPlanVersionsCreated.push(label);
      if (apply) {
        const created = await db.plan.create({
          data: {
            key: sub.planKey,
            version: sub.planVersion,
            name: anyVersion.name,
            nameHe: anyVersion.nameHe,
            billingInterval: anyVersion.billingInterval,
            basePrice: anyVersion.basePrice,
            currency: anyVersion.currency,
            includedAiUnits: anyVersion.includedAiUnits,
            salesOnly: true,
            active: true,
            status: "RETIRED",
            kind: "LEGACY",
            sortOrder: 950,
            internalNote: `Reconstructed by migrate-pricing for subscription ${sub.id}. Terms cloned from ${sub.planKey}@${anyVersion.version}.`,
          },
        });
        const sourceEntitlements = await db.planEntitlement.findMany({ where: { planId: anyVersion.id } });
        for (const e of sourceEntitlements) {
          await db.planEntitlement.create({
            data: { planId: created.id, entitlementKey: e.entitlementKey, valueType: e.valueType, value: e.value as any },
          });
        }
        plan = { ...created, estimations: [] } as any;
      } else {
        plan = { ...anyVersion, estimations: [] } as any;
      }
    }

    if (!plan) continue;

    // Volume options selected on this subscription (usually none pre-migration).
    let chatCredits = plan.includedAiUnits;
    let voiceCredits = 0;
    const split = await db.planEntitlement.findFirst({
      where: { planId: plan.id, entitlementKey: "config:credit_split" },
    });
    if (split?.value && typeof split.value === "object") {
      const v = split.value as any;
      if (Number.isFinite(Number(v.chat))) {
        chatCredits = Number(v.chat) || 0;
        voiceCredits = Number(v.voice) || 0;
      }
    }

    const options = await db.planVolumeOption.findMany({
      where: { planId: plan.id, key: { in: [sub.chatVolumeOptionKey, sub.voiceVolumeOptionKey].filter(Boolean) as string[] } },
    });
    for (const o of options) {
      if (o.channel === "CHAT") chatCredits += o.additionalCredits;
      else voiceCredits += o.additionalCredits;
    }

    const estimationRow = plan.estimations?.[0] ?? globalEstimation;
    const snapshotEstimation = estimationRow
      ? {
          chatCreditsPerEstimatedConversation: Number(estimationRow.chatCreditsPerEstimatedConversation),
          voiceCreditsPerEstimatedCall: Number(estimationRow.voiceCreditsPerEstimatedCall),
          businessDaysPerMonth: estimationRow.businessDaysPerMonth,
          version: estimationRow.version,
          configId: estimationRow.id,
          scope: estimationRow.scope,
          capturedAt: new Date().toISOString(),
          backfilled: true,
        }
      : null;

    if (!snapshotEstimation) {
      report.warnings.push(`No estimation config available when backfilling subscription ${sub.id}; snapshot written without ratios.`);
    }

    report.snapshotsBackfilled++;
    if (apply) {
      await db.subscription.update({
        where: { id: sub.id },
        data: {
          // The EXISTING price and allowance, frozen. Not a new price.
          snapshotPrice: plan.basePrice,
          snapshotCurrency: plan.currency,
          snapshotIncludedCredits: chatCredits + voiceCredits,
          snapshotEstimation: snapshotEstimation as any,
          snapshotAt: new Date(),
          billingInterval: plan.billingInterval,
        },
      });
    }
  }

  return report;
}

function printReport(r: MigrationReport): void {
  console.log("");
  console.log(r.dryRun ? "── DRY RUN (no changes written) ──" : "── APPLIED ──");
  console.log(`  legacy plans re-labelled           ${r.legacyPlansRelabelled}`);
  console.log(`  subscriptions inspected            ${r.subscriptionsInspected}`);
  console.log(`  snapshots backfilled               ${r.snapshotsBackfilled}`);
  console.log(`  snapshots already present          ${r.snapshotsAlreadyPresent}`);
  console.log(`  legacy plan versions reconstructed ${r.legacyPlanVersionsCreated.length}`);
  for (const l of r.legacyPlanVersionsCreated) console.log(`      • ${l}`);
  if (r.unmappedSubscriptions.length) {
    console.log(`  UNMAPPED subscriptions             ${r.unmappedSubscriptions.length}`);
    for (const u of r.unmappedSubscriptions) {
      console.log(`      • ${u.subscriptionId} (${u.planKey}@${u.planVersion}): ${u.reason}`);
    }
  }
  for (const w of r.warnings) console.log(`  ! ${w}`);
  console.log("");
  console.log("  Not touched: credit ledger, invoices, charges, payment methods,");
  console.log("  cancellation state, organization overrides.");
  if (r.dryRun) console.log("\n  Re-run with --apply to write.");
}

if (require.main === module) {
  const apply = process.argv.includes("--apply");
  migratePricing(prisma, { apply })
    .then((report) => {
      printReport(report);
      return prisma.$disconnect();
    })
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error("Pricing migration failed:", err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
