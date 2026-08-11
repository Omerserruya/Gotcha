/**
 * POC / Trial provisioning - Sysadmin only.
 *
 * Built on the existing POC machinery (`poc.service.ts`), which already makes an
 * evaluation a REAL enforced subscription rather than a bypass: the credit gate
 * bites, the 80/90/95/100% alerts fire, and expiry actually locks the workspace
 * down. This layer adds what the round needs on top:
 *
 *   • operator-editable TEMPLATES (duration, credit cap, restrictions) instead
 *     of hardcoded numbers;
 *   • separate TRIAL and POC labels and defaults sharing that infrastructure;
 *   • all-feature access granted as TRIAL-source entitlements that expire WITH
 *     the evaluation, so nothing lingers when it ends;
 *   • explicit, manual conversion to a paid plan - remaining credits transfer
 *     only when the template says so.
 *
 * There is no customer self-activation path. `customerSelfActivate` exists on
 * the template so that stays a deliberate decision rather than an oversight, and
 * it is refused here until it is turned on.
 */
import {
  prisma,
  rolloverIncluded,
  getBalance,
  setTenantEntitlement,
  materializeEntitlements,
  FEATURE_CATALOG,
  type BalanceView,
} from "@chatcenter/shared";
import { ensureBillableEntity } from "./billable-entity.service";
import { getActivePlanVersion } from "./plan.service";
import { createTrialSubscription } from "./subscription.service";
import { periodKeyFor } from "../lib/period";
import { commercialCurrencyFor } from "../lib/currency";
import { emitBillingEvent } from "../lib/events";

export async function listEvaluationTemplates() {
  const templates = await prisma.trialPocTemplate.findMany({ where: { active: true }, orderBy: { key: "asc" } });
  return templates.map((t) => ({
    key: t.key,
    nameEn: t.nameEn,
    nameHe: t.nameHe,
    durationDays: t.durationDays,
    creditCap: t.creditCap,
    allFeatures: t.allFeatures,
    autoRenew: t.autoRenew,
    autoPurchaseEnabled: t.autoPurchaseEnabled,
    customerSelfActivate: t.customerSelfActivate,
    transferRemainingCredits: t.transferRemainingCredits,
    restrictions: t.restrictions,
    bannerKind: t.bannerKind,
  }));
}

/** Ensure the evaluation plan row exists for a template key. */
async function ensureEvaluationPlan(templateKey: string, nameEn: string, kind: "POC" | "TRIAL") {
  const existing = await prisma.plan.findFirst({ where: { key: templateKey }, orderBy: { version: "desc" } });
  if (existing) return existing;
  return prisma.plan.create({
    data: {
      key: templateKey,
      version: 1,
      name: nameEn,
      basePrice: null,
      currency: "USD",
      includedAiUnits: 0,
      salesOnly: true,
      status: "ACTIVE",
      kind,
      sortOrder: 900,
      // No card, no charges, and no auto top-up: an evaluation must never
      // silently start spending someone's money.
      autoPurchaseEligible: false,
      creditPackagesEligible: false,
      internalNote: "Operator-provisioned evaluation access. Not a commercial plan.",
    },
  });
}

export interface EvaluationResult {
  subscriptionId: string;
  templateKey: string;
  kind: string;
  credits: number;
  expiresAt: Date;
  balance: BalanceView;
  featuresGranted: number;
}

/**
 * Provision evaluation access for one organization.
 *
 * The subscription is real and enforced, the credit cap is the INCLUDED
 * allowance (so consumption %, threshold alerts and the hard stop all work like
 * a paying tenant), and every granted feature carries the SAME expiry as the
 * evaluation itself.
 */
export async function setupEvaluation(input: {
  tenantId: string;
  templateKey: string;
  creditsOverride?: number;
  durationDaysOverride?: number;
  actor?: string;
  note?: string;
  /** Only an operator path may set this. Customer self-service cannot. */
  selfService?: boolean;
}): Promise<EvaluationResult> {
  const template = await prisma.trialPocTemplate.findUnique({ where: { key: input.templateKey } });
  if (!template || !template.active) throw new Error(`unknown_evaluation_template:${input.templateKey}`);

  if (input.selfService && !template.customerSelfActivate) {
    throw new Error("self_activation_disabled");
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: input.tenantId }, select: { id: true } });
  if (!tenant) throw new Error("unknown_tenant");

  const kind = template.bannerKind === "POC" ? "POC" : "TRIAL";
  const plan = await ensureEvaluationPlan(template.key, template.nameEn, kind);
  const entityId = await ensureBillableEntity(input.tenantId);

  const now = new Date();
  const durationDays = input.durationDaysOverride ?? template.durationDays;
  const credits = Math.max(0, input.creditsOverride ?? template.creditCap);
  const expiresAt = new Date(now.getTime() + durationDays * 86_400_000);

  const sub = await prisma.subscription.upsert({
    where: { billableEntityId: entityId },
    create: {
      billableEntityId: entityId,
      planKey: plan.key,
      planVersion: plan.version,
      status: "ACTIVE",
      // The whole point: the credit gate BITES on an evaluation too.
      enforcementEnabled: true,
      // Keeps it out of the renewal sweep - an evaluation never auto-renews
      // unless the template explicitly says otherwise.
      cancelAtPeriodEnd: !template.autoRenew,
      currentPeriodStart: now,
      currentPeriodEnd: expiresAt,
      trialEndsAt: null,
      trialPocTemplateKey: template.key,
      snapshotPrice: null,
      snapshotCurrency: "USD",
      snapshotIncludedCredits: credits,
      snapshotAt: now,
    },
    update: {
      planKey: plan.key,
      planVersion: plan.version,
      status: "ACTIVE",
      enforcementEnabled: true,
      cancelAtPeriodEnd: !template.autoRenew,
      currentPeriodStart: now,
      currentPeriodEnd: expiresAt,
      trialEndsAt: null,
      trialPocTemplateKey: template.key,
      snapshotIncludedCredits: credits,
      snapshotAt: now,
    },
  });

  // The budget: the cap IS the included allowance, so the usage percentage and
  // the alerts are computed against exactly it. A previous evaluation allowance
  // is expired by the rollover rather than stacked on top.
  await rolloverIncluded(input.tenantId, periodKeyFor(now), credits, expiresAt, `${kind.toLowerCase()}:${input.actor ?? "system"}`);

  // All-feature access, granted as TRIAL-source entitlements sharing the
  // evaluation's expiry so they drop out on their own when it ends.
  let featuresGranted = 0;
  if (template.allFeatures) {
    for (const f of FEATURE_CATALOG) {
      if (f.entitlementType !== "BOOLEAN" || !f.implemented) continue;
      await setTenantEntitlement({
        tenantId: input.tenantId,
        key: f.key,
        valueType: "BOOLEAN",
        value: { bool: true },
        source: "TRIAL",
        expiresAt,
        reason: `${kind} evaluation`,
        createdBy: input.actor,
      });
      featuresGranted++;
    }
  }

  // Optional per-evaluation limits, applied as TRIAL-source overrides so they
  // also expire with the evaluation.
  const restrictions = (template.restrictions as any) ?? {};
  for (const [k, v] of Object.entries((restrictions.limits ?? {}) as Record<string, number>)) {
    await setTenantEntitlement({
      tenantId: input.tenantId, key: k, valueType: "COUNTER", value: { count: Number(v) },
      source: "TRIAL", expiresAt, reason: `${kind} limit`, createdBy: input.actor,
    });
  }

  await materializeEntitlements(input.tenantId, input.actor);

  // No auto top-up on an evaluation unless the template says so.
  await prisma.autoPurchasePolicy.upsert({
    where: { billableEntityId: entityId },
    create: {
      billableEntityId: entityId,
      enabled: template.autoPurchaseEnabled,
      // The organization's commercial currency, not a literal. See lib/currency.
      currency: await commercialCurrencyFor(entityId),
      updatedBy: input.actor,
    },
    update: { enabled: template.autoPurchaseEnabled, updatedBy: input.actor },
  });

  await prisma.subscriptionEvent.create({
    data: {
      subscriptionId: sub.id, type: `${kind.toLowerCase()}_started`, toStatus: "ACTIVE",
      actor: input.actor ?? "system",
      metadata: { templateKey: template.key, credits, expiresAt, note: input.note ?? null } as any,
    },
  });
  await emitBillingEvent({
    type: "subscription.activated",
    tenantId: input.tenantId,
    data: { planKey: plan.key, evaluation: kind, credits, expiresAt: expiresAt.toISOString() },
  });

  return {
    subscriptionId: sub.id,
    templateKey: template.key,
    kind,
    credits,
    expiresAt,
    balance: await getBalance(input.tenantId),
    featuresGranted,
  };
}

/**
 * Convert an evaluation into a paid plan.
 *
 * Manual, never automatic. Remaining evaluation credits are carried over ONLY
 * when the template says so - the default is that they expire with the
 * evaluation, because they were never purchased.
 */
export async function convertEvaluationToPaid(input: {
  tenantId: string;
  planKey: string;
  actor?: string;
}): Promise<{ converted: true; carriedOverCredits: number; planKey: string }> {
  const link = await prisma.billableEntityTenant.findUnique({
    where: { tenantId: input.tenantId },
    include: { entity: { include: { subscription: true } } },
  });
  const sub = link?.entity.subscription;
  if (!sub) throw new Error("no_subscription");

  const template = sub.trialPocTemplateKey
    ? await prisma.trialPocTemplate.findUnique({ where: { key: sub.trialPocTemplateKey } })
    : null;

  const target = await getActivePlanVersion(input.planKey);
  if (!target) throw new Error(`unknown_plan:${input.planKey}`);
  if (target.kind === "POC" || target.kind === "TRIAL") throw new Error("target_must_be_a_paid_plan");

  const balanceBefore = await getBalance(input.tenantId);
  const carryOver = template?.transferRemainingCredits ? Math.max(0, balanceBefore.includedRemaining) : 0;

  // Clear the evaluation's TRIAL-source entitlements so the paid plan's own
  // entitlements decide access from here, rather than a lingering all-features
  // grant quietly outliving the evaluation.
  await prisma.tenantEntitlement.deleteMany({ where: { tenantId: input.tenantId, source: "TRIAL" } });

  // Reuse the normal subscription path: card check, snapshot, credit grant and
  // entitlement materialization all behave exactly as they do for any customer.
  await createTrialSubscription({ tenantId: input.tenantId, planKey: target.key, actor: input.actor });

  if (carryOver > 0) {
    const { grantUnits } = await import("@chatcenter/shared");
    await grantUnits({
      tenantId: input.tenantId,
      bucket: "PURCHASED",
      grantType: "PROMO",
      units: carryOver,
      source: "evaluation_carryover",
    });
  }

  await prisma.subscription.updateMany({
    where: { billableEntityId: link!.billableEntityId },
    data: { trialPocTemplateKey: null },
  });

  return { converted: true, carriedOverCredits: carryOver, planKey: target.key };
}
