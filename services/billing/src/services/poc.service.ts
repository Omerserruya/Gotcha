/**
 * POC / pilot tenants - "free trial without a card".
 *
 * A POC is a REAL subscription (so the AI-Units gate enforces it - never the
 * fail-open no-subscription bypass) on a dedicated sales-only `poc` plan:
 *
 *   • no card, no charges, no dunning - `cancelAtPeriodEnd=true` keeps it out
 *     of the renewal sweep, and the plan has no price to charge;
 *   • the operator sets the credit budget: granted as the INCLUDED allowance
 *     via rolloverIncluded(), so the 80/90/95/100% usage-threshold alerts and
 *     the hard-block at zero work exactly like a paying tenant;
 *   • optional expiry = currentPeriodEnd; expireDuePocs() (run by the billing
 *     cycle) cancels it - CANCELED is refused by the AI gate in hard mode -
 *     and reverts the POC's expired TRIAL feature entitlements so the UI
 *     locks down too.
 *
 * Feature selection is written by the caller (the auth system console) as
 * TRIAL-source TenantEntitlements sharing the same expiry.
 */
import {
  prisma,
  rolloverIncluded,
  getBalance,
  invalidatePermissionsCache,
  setTenantEntitlement,
  materializeEntitlements,
  ALL_LICENSE_KEYS,
  type BalanceView,
} from "@chatcenter/shared";
import { ensureBillableEntity, tenantsForEntity } from "./billable-entity.service";
import { periodKeyFor } from "../lib/period";
import { emitBillingEvent } from "../lib/events";

export const POC_PLAN_KEY = "poc";
const FAR_FUTURE_DAYS = 3650; // "no expiry" - far enough to be effectively unlimited

async function ensurePocPlan(): Promise<void> {
  await prisma.plan.upsert({
    where: { key_version: { key: POC_PLAN_KEY, version: 1 } },
    // `kind` is corrected on every call, including for the row that already
    // exists. It was created without one and took the PUBLIC default, which is
    // not cosmetic: the entitlement gate asks the PLAN whether an expired
    // subscription is an expired POC, and a POC labelled PUBLIC answers no. The
    // window closing was therefore enforced only by the sweep that cancels it,
    // and a POC the sweep had not reached yet kept working past its expiry.
    update: { kind: "POC", salesOnly: true },
    create: {
      key: POC_PLAN_KEY,
      version: 1,
      name: "POC / Pilot",
      basePrice: null,
      includedAiUnits: 0,
      salesOnly: true,
      kind: "POC",
    },
  });
}

export async function setupPoc(input: {
  tenantId: string;
  credits: number;
  expiresAt?: Date | null;
  actor?: string;
}): Promise<{ subscriptionId: string; balance: BalanceView; expiresAt: Date | null }> {
  const { tenantId } = input;
  const credits = Math.max(0, input.credits);
  const entityId = await ensureBillableEntity(tenantId);
  await ensurePocPlan();

  const now = new Date();
  const periodEnd = input.expiresAt ?? new Date(now.getTime() + FAR_FUTURE_DAYS * 86_400_000);

  const sub = await prisma.subscription.upsert({
    where: { billableEntityId: entityId },
    create: {
      billableEntityId: entityId,
      planKey: POC_PLAN_KEY,
      planVersion: 1,
      status: "ACTIVE",
      enforcementEnabled: true, // the whole point: the credits gate BITES
      cancelAtPeriodEnd: true, // keeps the renewal sweep away - no charges, ever
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      trialEndsAt: null,
    },
    update: {
      planKey: POC_PLAN_KEY,
      planVersion: 1,
      status: "ACTIVE",
      enforcementEnabled: true,
      cancelAtPeriodEnd: true,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      trialEndsAt: null,
    },
  });

  // The budget: INCLUDED allowance = the operator-set credits, so consumption %
  // (and the 80/100 alerts) are computed against exactly that budget. Any
  // previous POC allowance is expired by the rollover, not stacked - including
  // one granted in the SAME period, which is what a re-provision or a repair
  // is. Without that, running POC setup twice would leave double the budget the
  // operator entered.
  await rolloverIncluded(
    tenantId,
    periodKeyFor(now),
    credits,
    periodEnd,
    `poc:${input.actor ?? "system"}`,
    prisma,
    { replaceCurrentPeriod: true },
  );

  await emitBillingEvent({
    type: "subscription.activated",
    tenantId,
    data: { planKey: POC_PLAN_KEY, poc: true, credits, expiresAt: input.expiresAt?.toISOString() ?? null },
  });

  return { subscriptionId: sub.id, balance: await getBalance(tenantId), expiresAt: input.expiresAt ?? null };
}

/**
 * The license domains a POC's feature areas are chosen from.
 *
 * Derived from the permission catalog rather than listed here, so a new domain
 * cannot appear in the product and be silently absent from POC provisioning -
 * which, given license semantics below, would mean it was silently GRANTED.
 */
export const POC_FEATURE_DOMAINS: string[] = Array.from(
  new Set(ALL_LICENSE_KEYS.map((k) => k.split(":")[0] as string)),
).sort();

export interface PocProvisioningInput {
  tenantId: string;
  credits: number;
  expiresAt?: Date | null;
  /** License domains this POC may use. Empty or omitted means all of them. */
  features?: string[] | null;
  /** Operator note. Never shown to the customer. */
  note?: string | null;
  actor?: string;
}

export interface PocProvisioningResult {
  subscriptionId: string;
  credits: number;
  expiresAt: Date | null;
  featuresEnabled: string[];
  featuresDenied: string[];
  balance: BalanceView;
}

export class PocProvisioningRefused extends Error {
  constructor(readonly code: string, detail?: string) {
    super(`[billing] poc provisioning refused: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "PocProvisioningRefused";
  }
}

/**
 * Provision a POC completely: subscription, credits, expiry and feature areas.
 *
 * ONE entry point, because there were two halves in two services - billing set
 * up the money and the auth console wrote the entitlement rows - and nothing
 * required both to happen. A POC created through one and not the other is a
 * tenant with credits and every feature, or with features and no budget.
 *
 * Idempotent by construction rather than by a guard: the subscription is an
 * upsert, the allowance REPLACES rather than stacks, and each entitlement row
 * is set to an absolute value, not incremented. Running it again with the same
 * input leaves the same state; running it with different input is the operator
 * changing the POC, which is exactly what should happen.
 */
export async function provisionPoc(input: PocProvisioningInput): Promise<PocProvisioningResult> {
  const tenant = await prisma.tenant.findUnique({ where: { id: input.tenantId }, select: { id: true } });
  if (!tenant) throw new PocProvisioningRefused("tenant_not_found");

  if (!Number.isFinite(input.credits) || input.credits <= 0) {
    throw new PocProvisioningRefused("credit_budget_required");
  }
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw new PocProvisioningRefused("expiry_must_be_in_the_future");
  }

  const picked = input.features?.length ? new Set(input.features) : null;
  if (picked) {
    for (const f of picked) {
      if (!POC_FEATURE_DOMAINS.includes(f)) throw new PocProvisioningRefused("unknown_feature_domain", f);
    }
  }

  // Money first: an enforced subscription plus the operator's budget.
  const billing = await setupPoc({
    tenantId: input.tenantId,
    credits: input.credits,
    expiresAt,
    actor: input.actor,
  });

  // License semantics are default-ALLOW: an absent row means allowed. So an
  // EXACT feature set needs an explicit row for every domain - true for the
  // chosen ones and false for the rest - or "we only enabled conversations"
  // would quietly mean "we enabled everything except the ones we listed".
  const enabled: string[] = [];
  const denied: string[] = [];
  for (const domain of POC_FEATURE_DOMAINS) {
    const on = picked ? picked.has(domain) : true;
    await setTenantEntitlement({
      tenantId: input.tenantId,
      key: domain,
      valueType: "BOOLEAN",
      // TRIAL source, sharing the POC's expiry, so the grant drops out on its
      // own when the window closes instead of outliving it.
      value: on,
      source: "TRIAL",
      expiresAt,
      reason: input.note ? `POC provisioning: ${input.note}` : "POC provisioning",
      createdBy: input.actor,
    });
    (on ? enabled : denied).push(domain);
  }

  // Materialize so the permission resolver and the workspace UI agree with the
  // entitlement rows immediately, rather than at the next sweep.
  await materializeEntitlements(input.tenantId, input.actor);

  return {
    subscriptionId: billing.subscriptionId,
    credits: input.credits,
    expiresAt,
    featuresEnabled: enabled,
    featuresDenied: denied,
    balance: await getBalance(input.tenantId),
  };
}

/**
 * Cancel POCs whose window closed and revert their expired TRIAL feature rows.
 * Expired TRIAL entitlements silently drop out of getEffectiveEntitlements(),
 * but their materialized TenantFeature rows would keep the last value forever -
 * flip those OFF explicitly so the workspace UI locks down with the POC.
 */
export async function expireDuePocs(now = new Date()): Promise<number> {
  const due = await prisma.subscription.findMany({
    where: { planKey: POC_PLAN_KEY, status: "ACTIVE", currentPeriodEnd: { lte: now } },
    select: { id: true, billableEntityId: true },
  });
  for (const sub of due) {
    await prisma.subscription.update({ where: { id: sub.id }, data: { status: "CANCELED" } });
    for (const tenantId of await tenantsForEntity(sub.billableEntityId)) {
      const expired = await prisma.tenantEntitlement.findMany({
        where: { tenantId, source: "TRIAL", valueType: "BOOLEAN", expiresAt: { lte: now } },
        select: { entitlementKey: true },
      });
      for (const e of expired) {
        await prisma.tenantFeature.updateMany({ where: { tenantId, feature: e.entitlementKey }, data: { enabled: false } });
      }
      if (expired.length) invalidatePermissionsCache({ tenantId });
      await emitBillingEvent({ type: "subscription.canceled", tenantId, data: { planKey: POC_PLAN_KEY, poc: true, reason: "poc_expired" } });
    }
  }
  return due.length;
}
