/**
 * Demo pricing state for running-UI verification. DEV ONLY.
 *
 *   npm run db:seed-pricing-demo            (create)
 *   npm run db:seed-pricing-demo -- --clean (remove everything it created)
 *
 * Puts the tenant that owns the first active user on AI Workforce with a real
 * commercial snapshot, a partly-consumed wallet, an auto-purchase policy, and a
 * set of FINALIZED conversation-usage aggregates so the Sysadmin cost dashboard
 * has a believable right-skewed distribution to render.
 *
 * It exists because "the pricing pages render" is not verification - they have
 * to render REAL numbers from the real services, and that needs data. Every row
 * it writes is tagged (source "demo:*", conversationId "demo-*") so `--clean`
 * removes exactly what it added and nothing else.
 *
 * This is NOT part of the product seed. It writes credit lots and ledger
 * entries, so never run it against an environment with real billing data.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // ── Drop the migration fixture ──
  const fixtures = await prisma.tenant.findMany({ where: { slug: { startsWith: "mig-fixture" } }, select: { id: true } });
  for (const t of fixtures) {
    const link = await prisma.billableEntityTenant.findUnique({ where: { tenantId: t.id } });
    if (link) {
      await prisma.subscription.deleteMany({ where: { billableEntityId: link.billableEntityId } });
      await prisma.billableEntityTenant.delete({ where: { tenantId: t.id } });
      await prisma.billableEntity.delete({ where: { id: link.billableEntityId } }).catch(() => {});
    }
    await prisma.aiUnitLedgerEntry.deleteMany({ where: { tenantId: t.id } });
    await prisma.aiUnitLot.deleteMany({ where: { tenantId: t.id } });
    await prisma.tenantAiBalance.deleteMany({ where: { tenantId: t.id } });
    await prisma.tenant.delete({ where: { id: t.id } });
  }
  // Reconstructed legacy version from the fixture run.
  await prisma.plan.deleteMany({ where: { key: "pro", version: 7 } });
  console.log(`  • removed ${fixtures.length} migration fixture tenants`);

  // ── Pick a real tenant to demo with ──
  // Use the tenant the (only) real user actually belongs to, so the customer
  // billing pages render this data rather than an empty state for a tenant
  // nobody can log into.
  const user = await prisma.user.findFirst({ where: { isActive: true }, select: { tenantId: true } });
  const tenant = user
    ? await prisma.tenant.findUnique({ where: { id: user.tenantId } })
    : await prisma.tenant.findFirst({ where: { status: "ACTIVE" }, orderBy: { createdAt: "asc" } });
  if (!tenant) {
    console.log("  ! no active tenant found; skipping demo subscription");
    await prisma.$disconnect();
    return;
  }

  const link = await prisma.billableEntityTenant.findUnique({ where: { tenantId: tenant.id } });
  let entityId = link?.billableEntityId;
  if (!entityId) {
    const e = await prisma.billableEntity.create({ data: { kind: "TENANT", displayName: tenant.name } });
    await prisma.billableEntityTenant.create({ data: { billableEntityId: e.id, tenantId: tenant.id } });
    entityId = e.id;
  }

  const plan = await prisma.plan.findFirst({ where: { key: "ai_workforce", status: "ACTIVE" } });
  if (!plan) throw new Error("run db:seed-pricing first");

  const now = new Date();
  const periodEnd = new Date(now.getTime() + 18 * 86_400_000);

  await prisma.subscription.upsert({
    where: { billableEntityId: entityId },
    create: {
      billableEntityId: entityId, planKey: plan.key, planVersion: plan.version, status: "ACTIVE",
      enforcementEnabled: true, currentPeriodStart: now, currentPeriodEnd: periodEnd,
      billingInterval: "MONTHLY", snapshotPrice: "499.00", snapshotCurrency: "USD",
      snapshotIncludedCredits: 2000, snapshotAt: now, chatVolumeOptionKey: "chat_10",
      snapshotEstimation: { chatCreditsPerEstimatedConversation: 8, voiceCreditsPerEstimatedCall: 20, businessDaysPerMonth: 25, version: 1, scope: "GLOBAL" },
    },
    update: {
      planKey: plan.key, planVersion: plan.version, status: "ACTIVE",
      currentPeriodStart: now, currentPeriodEnd: periodEnd,
      snapshotPrice: "499.00", snapshotCurrency: "USD", snapshotIncludedCredits: 2000,
      snapshotAt: now, chatVolumeOptionKey: "chat_10",
      snapshotEstimation: { chatCreditsPerEstimatedConversation: 8, voiceCreditsPerEstimatedCall: 20, businessDaysPerMonth: 25, version: 1, scope: "GLOBAL" },
    },
  });

  // Wallet: partly consumed plan credits + a purchased top-up.
  await prisma.aiUnitLedgerEntry.deleteMany({ where: { tenantId: tenant.id, source: { startsWith: "demo" } } });
  await prisma.aiUnitLot.deleteMany({ where: { tenantId: tenant.id, source: { startsWith: "demo" } } });
  const periodKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const included = await prisma.aiUnitLot.create({
    data: {
      tenantId: tenant.id, bucket: "INCLUDED", grantType: "PLAN",
      unitsGranted: "2000.000000", unitsRemaining: "742.000000",
      periodKey, expiresAt: periodEnd, source: "demo:plan",
    },
  });
  const purchased = await prisma.aiUnitLot.create({
    data: {
      tenantId: tenant.id, bucket: "PURCHASED", grantType: "PURCHASE",
      unitsGranted: "5000.000000", unitsRemaining: "5000.000000", source: "demo:package",
    },
  });
  for (const [lot, units, type] of [[included, "2000.000000", "GRANT"], [purchased, "5000.000000", "GRANT"]] as const) {
    await prisma.aiUnitLedgerEntry.create({
      data: { tenantId: tenant.id, lotId: lot.id, entryType: type, bucket: lot.bucket, units, periodKey: lot.periodKey, source: "demo" },
    });
  }
  await prisma.tenantAiBalance.upsert({
    where: { tenantId: tenant.id },
    create: { tenantId: tenant.id, includedRemaining: "742.000000", purchasedRemaining: "5000.000000", includedAllowance: "2000.000000", periodKey },
    update: { includedRemaining: "742.000000", purchasedRemaining: "5000.000000", includedAllowance: "2000.000000", periodKey },
  });

  await prisma.autoPurchasePolicy.upsert({
    where: { billableEntityId: entityId },
    create: {
      billableEntityId: entityId, enabled: true, thresholdPct: 10, warningThresholdPct: 80,
      packageKey: "credits_5000", maxMonthlySpend: "500.00", currency: "USD",
      monthSpendKey: periodKey, monthSpentAmount: "110.00", limitBehavior: "STOP_AI",
    },
    update: {
      enabled: true, thresholdPct: 10, warningThresholdPct: 80, packageKey: "credits_5000",
      maxMonthlySpend: "500.00", currency: "USD", monthSpendKey: periodKey,
      monthSpentAmount: "110.00", limitBehavior: "STOP_AI",
    },
  });

  // ── Finalized conversation-cost aggregates for the Sysadmin dashboard ──
  // Delete by the demo id prefix, not by tenant: a previous run may have put
  // these ids on a different tenant, and conversationId is globally unique.
  await prisma.conversationUsageEventLink.deleteMany({ where: { aggregate: { conversationId: { startsWith: "demo-" } } } });
  await prisma.conversationUsageAggregate.deleteMany({ where: { conversationId: { startsWith: "demo-" } } });

  // A believable right-skewed spread: most conversations cheap, a long tail.
  const credits = [4.1, 5.2, 6.0, 6.4, 7.1, 7.8, 8.2, 8.9, 9.4, 10.1, 11.3, 12.7, 14.2, 17.5, 23.8, 31.2];
  let i = 0;
  for (const c of credits) {
    i++;
    const finalizedAt = new Date(now.getTime() - i * 3 * 3_600_000);
    const inTok = Math.round(c * 900);
    const outTok = Math.round(c * 160);
    await prisma.conversationUsageAggregate.create({
      data: {
        conversationId: `demo-convo-${i}`,
        tenantId: tenant.id,
        channel: i % 4 === 0 ? "INSTAGRAM" : "WHATSAPP",
        conversationType: "CHAT",
        planKey: plan.key,
        primaryModel: c > 15 ? "gpt-5" : "gpt-5-mini",
        startedAt: new Date(finalizedAt.getTime() - 5_400_000),
        resolvedAt: new Date(finalizedAt.getTime() - 1_800_000),
        finalizedAt,
        totalCredits: c.toFixed(6),
        totalInputTokens: inTok,
        totalOutputTokens: outTok,
        totalTokens: inTok + outTok,
        modelCostUsd: (c * 0.0006).toFixed(8),
        eventCount: 3 + (i % 4),
        summaryIncluded: true,
        status: "FINALIZED",
      },
    });
  }
  // A handful of voice conversations, materially more expensive per call.
  for (const c of [18.4, 22.1, 26.7, 33.9]) {
    i++;
    const finalizedAt = new Date(now.getTime() - i * 4 * 3_600_000);
    await prisma.conversationUsageAggregate.create({
      data: {
        conversationId: `demo-call-${i}`,
        tenantId: tenant.id,
        channel: "VOICE",
        conversationType: "VOICE",
        planKey: plan.key,
        primaryModel: "voice",
        startedAt: new Date(finalizedAt.getTime() - 2_400_000),
        resolvedAt: new Date(finalizedAt.getTime() - 1_800_000),
        finalizedAt,
        totalCredits: c.toFixed(6),
        totalInputTokens: Math.round(c * 1400),
        totalOutputTokens: Math.round(c * 300),
        totalTokens: Math.round(c * 1700),
        modelCostUsd: (c * 0.0011).toFixed(8),
        eventCount: 5,
        summaryIncluded: true,
        voiceIncluded: true,
        status: "FINALIZED",
      },
    });
  }

  console.log(`  • demo subscription + wallet + ${credits.length + 4} finalized conversation aggregates on "${tenant.name}"`);
  await prisma.$disconnect();
}


async function clean() {
  const links = await prisma.conversationUsageEventLink.deleteMany({
    where: { aggregate: { conversationId: { startsWith: "demo-" } } },
  });
  const aggs = await prisma.conversationUsageAggregate.deleteMany({ where: { conversationId: { startsWith: "demo-" } } });
  const entries = await prisma.aiUnitLedgerEntry.deleteMany({ where: { source: { startsWith: "demo" } } });
  const lots = await prisma.aiUnitLot.deleteMany({ where: { source: { startsWith: "demo" } } });

  // Recompute the balance snapshot from what is actually left, rather than
  // deleting it - another (real) lot may exist for the same tenant.
  const tenants = await prisma.tenantAiBalance.findMany({ select: { tenantId: true } });
  for (const { tenantId } of tenants) {
    const remaining = await prisma.aiUnitLot.findMany({ where: { tenantId }, select: { bucket: true, unitsRemaining: true } });
    if (remaining.length === 0) {
      await prisma.tenantAiBalance.delete({ where: { tenantId } }).catch(() => {});
      continue;
    }
    const inc = remaining.filter((l) => l.bucket === "INCLUDED").reduce((s, l) => s + Number(l.unitsRemaining), 0);
    const pur = remaining.filter((l) => l.bucket === "PURCHASED").reduce((s, l) => s + Number(l.unitsRemaining), 0);
    await prisma.tenantAiBalance.update({
      where: { tenantId },
      data: { includedRemaining: inc.toFixed(6), purchasedRemaining: pur.toFixed(6) },
    });
  }

  console.log(`  • removed ${aggs.count} aggregates, ${links.count} event links, ${lots.count} lots, ${entries.count} ledger entries`);
  console.log("  • subscriptions and auto-purchase policies left in place (they may be real)");
  await prisma.$disconnect();
}

const run = process.argv.includes("--clean") ? clean : main;
run().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
