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
  BOOLEAN_FEATURE_KEYS,
  isUnsellable,
  type BalanceView,
} from "@chatcenter/shared";
import { ensureBillableEntity, tenantsForEntity } from "./billable-entity.service";
import { periodKeyFor } from "../lib/period";
import { emitBillingEvent } from "../lib/events";
import { sendEvaluationEndedEmail } from "./evaluation-ended.service";

export const POC_PLAN_KEY = "poc";
/**
 * What a pilot may use, mirroring the `ai_workforce` plan.
 *
 * Deliberately NOT `limit:included_ai_units` (the operator sets the credit
 * budget) and NOT `limit:voice_channels` (granted by the voice license).
 */
const PILOT_LIMITS: Record<string, number> = {
  "limit:channels": 8,
  "limit:ai_employees": 5,
  "limit:users": 15,
  "limit:departments": 8,
  "limit:knowledge_sources": 50,
  "limit:workflows": 30,
  "limit:storage_gb": 100,
  "limit:data_retention_days": 365,
};
/**
 * The fine-grained, default-DENY capability keys a pilot receives. Mirrors the
 * `ai_workforce` plan, minus voice - see the block that consumes this.
 *
 * Derived from the shipped catalog so a capability added later cannot be
 * silently missing from every pilot.
 */
export const PILOT_CAPABILITY_KEYS: string[] = BOOLEAN_FEATURE_KEYS.filter(
  (k) => !isUnsellable(k) && !k.startsWith("voice."),
);

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

  // A pilot has to be able to exercise the product it is a pilot OF.
  //
  // The `poc` plan carries no entitlements at all, so without this every limit
  // fell through to the feature catalog's defaults - which exist for a tenant
  // with NO plan, not for an evaluation: 2 channels, 0 AI employees, 3 users.
  // A customer connected four channels through the OAuth paths (which do not
  // check the cap) and then met a 402 on the first gated connect, with no way
  // to see why. And 0 AI employees means a POC could never create the thing the
  // product is named after.
  //
  // Values mirror `ai_workforce`, so a pilot behaves like the product it is
  // previewing rather than like a number invented here. Two are deliberately
  // absent: the credit budget is the operator's explicit decision, made above,
  // and voice channels belong to the voice license (see expandVoiceLicense),
  // which is the more specific answer for the tenants that have it.
  for (const [key, count] of Object.entries(PILOT_LIMITS)) {
    await setTenantEntitlement({
      tenantId: input.tenantId,
      key,
      valueType: "COUNTER",
      value: { count },
      source: "TRIAL",
      expiresAt,
      reason: input.note ? `POC provisioning: ${input.note}` : "POC provisioning",
      createdBy: input.actor,
    });
  }

  // The SAME hole as the limits above, in the other namespace, and the one that
  // actually reached a customer.
  //
  // There are two key namespaces. The license domains written above (`ai`,
  // `conversation`) are default-ALLOW and drive navigation. The fine-grained
  // capability keys are dotted (`ai.copilot`, `ai.employee`) and are
  // default-DENY - `requireEntitlement("ai.copilot")` refuses anything it
  // cannot find. Every sellable plan carries 44 rows covering them. The `poc`
  // plan carries none, and POC provisioning wrote only the coarse domains.
  //
  // So a pilot got `ai: true` - the AI section appeared in the nav, the
  // operator's console said the feature was enabled - and then every co-pilot
  // request 402'd with "your plan does not include the co-pilot". Enabled
  // everywhere a human looked, denied at the only place that decides.
  //
  // Derived from the catalog rather than listed, for the reason
  // POC_FEATURE_DOMAINS is: a capability shipped later must not be silently
  // absent here. Gated on the operator's chosen domains, so restricting a
  // pilot to `conversation` does not hand it the co-pilot through the back
  // door. Voice is excluded for the same reason `limit:voice_channels` is -
  // it belongs to the voice license, which is the more specific answer.
  for (const key of PILOT_CAPABILITY_KEYS) {
    const domain = key.split(".")[0] as string;
    const on = picked ? picked.has(domain) : true;
    await setTenantEntitlement({
      tenantId: input.tenantId,
      key,
      valueType: "BOOLEAN",
      value: on,
      source: "TRIAL",
      expiresAt,
      reason: input.note ? `POC provisioning: ${input.note}` : "POC provisioning",
      createdBy: input.actor,
    });
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
 * Grant a live evaluation the pilot capabilities it does not have yet.
 *
 * `PILOT_CAPABILITY_KEYS` is derived from the shipped catalog precisely so a
 * capability added later cannot be silently missing from a pilot - but that
 * derivation only ran at PROVISIONING time, so the promise held for exactly
 * one moment. A POC set up before a capability existed never received it, and
 * every fine-grained gate for it answered "not included in your plan" while
 * the operator believed the pilot had everything.
 *
 * Found in production: a POC with 102 legacy feature rows and NONE of the 21
 * catalog capability keys, so the chat copilot, the knowledge base and the
 * dashboards were all denied.
 *
 * Deliberately narrow:
 *   * evaluations only (POC / TRIAL plans), never a paying customer - their
 *     capabilities come from what they bought;
 *   * only keys that are MISSING; an operator's explicit denial is a row that
 *     exists, and is left exactly as it is;
 *   * credits, expiry and everything else are untouched.
 */
export async function reconcileEvaluationCapabilities(input: {
  tenantId: string;
  actor?: string;
}): Promise<{ granted: string[]; alreadyPresent: number }> {
  const link = await prisma.billableEntityTenant.findUnique({
    where: { tenantId: input.tenantId },
    include: { entity: { include: { subscription: true } } },
  });
  const sub = link?.entity.subscription;
  if (!sub || sub.status !== "ACTIVE") return { granted: [], alreadyPresent: 0 };

  const plan = await prisma.plan.findUnique({
    where: { key_version: { key: sub.planKey, version: sub.planVersion } },
    select: { kind: true },
  });
  if (!plan || (plan.kind !== "POC" && plan.kind !== "TRIAL")) return { granted: [], alreadyPresent: 0 };

  const existing = await prisma.tenantEntitlement.findMany({
    where: { tenantId: input.tenantId, entitlementKey: { in: PILOT_CAPABILITY_KEYS } },
    select: { entitlementKey: true },
  });
  const have = new Set(existing.map((e) => e.entitlementKey));
  const missing = PILOT_CAPABILITY_KEYS.filter((k) => !have.has(k));
  if (missing.length === 0) return { granted: [], alreadyPresent: have.size };

  for (const key of missing) {
    await setTenantEntitlement({
      tenantId: input.tenantId,
      key,
      valueType: "BOOLEAN",
      value: true,
      source: "TRIAL",
      // Same expiry as the evaluation, so a late grant cannot outlive it.
      expiresAt: sub.currentPeriodEnd ?? undefined,
      reason: "Evaluation capability reconciliation",
      createdBy: input.actor,
    });
  }
  await materializeEntitlements(input.tenantId, input.actor);
  invalidatePermissionsCache({ tenantId: input.tenantId });

  return { granted: missing, alreadyPresent: have.size };
}

/**
 * Cancel evaluations whose window closed and revert their expired TRIAL feature
 * rows. Expired TRIAL entitlements silently drop out of
 * getEffectiveEntitlements(), but their materialized TenantFeature rows would
 * keep the last value forever - flip those OFF explicitly so the workspace UI
 * locks down with the evaluation.
 *
 * Selected by the plan's KIND, not by one hardcoded plan key.
 *
 * It used to match `planKey === "poc"`, which covered the POCs this file
 * provisions and nothing else. Template-provisioned evaluations
 * (evaluation.service) live on plans keyed by the TEMPLATE - "pilot_30d" and
 * the like - with kind POC or TRIAL, and this was the only sweep that expires
 * them. They therefore stayed ACTIVE past their end date with every granted
 * feature still switched on in the workspace: the one thing an evaluation must
 * not do is quietly become permanent.
 *
 * TRIALING subscriptions are deliberately untouched - the trial branch of the
 * billing cycle converts those, and cancelling one here would end a trial that
 * was about to be charged and become a paying customer.
 */
export async function expireDuePocs(now = new Date()): Promise<number> {
  const candidates = await prisma.subscription.findMany({
    where: { status: "ACTIVE", currentPeriodEnd: { lte: now } },
    select: { id: true, billableEntityId: true, planKey: true, planVersion: true },
  });
  if (!candidates.length) return 0;

  // Resolve kinds in one query rather than per subscription: this runs inside
  // the billing cycle, over the whole estate.
  const plans = await prisma.plan.findMany({
    where: { OR: candidates.map((c) => ({ key: c.planKey, version: c.planVersion })) },
    select: { key: true, version: true, kind: true },
  });
  const kindBy = new Map(plans.map((p) => [`${p.key}@${p.version}`, p.kind]));

  const due = candidates.filter((c) => {
    const kind = kindBy.get(`${c.planKey}@${c.planVersion}`);
    return kind === "POC" || kind === "TRIAL";
  });

  for (const sub of due) {
    await prisma.subscription.update({ where: { id: sub.id }, data: { status: "CANCELED" } });
    const kind = kindBy.get(`${sub.planKey}@${sub.planVersion}`) === "POC" ? "POC" : "TRIAL";
    for (const tenantId of await tenantsForEntity(sub.billableEntityId)) {
      const expired = await prisma.tenantEntitlement.findMany({
        where: { tenantId, source: "TRIAL", valueType: "BOOLEAN", expiresAt: { lte: now } },
        select: { entitlementKey: true },
      });
      for (const e of expired) {
        await prisma.tenantFeature.updateMany({ where: { tenantId, feature: e.entitlementKey }, data: { enabled: false } });
      }
      if (expired.length) invalidatePermissionsCache({ tenantId });
      await emitBillingEvent({
        type: "subscription.canceled",
        tenantId,
        data: { planKey: sub.planKey, poc: true, reason: "poc_expired" },
      });
      // Ask. An evaluation that ends without anyone being invited to subscribe
      // is a customer who simply finds the product stopped working - which is
      // both a worse experience and a lost sale. The in-app prompt is derived
      // from this same subscription row (see evaluationPromptFor); this is the
      // one email that goes with it.
      await sendEvaluationEndedEmail({
        tenantId,
        subscriptionId: sub.id,
        kind,
        planName: sub.planKey,
      });
    }
  }
  return due.length;
}

/**
 * Reconcile every live evaluation. Run by the billing tick.
 *
 * Iterating evaluations rather than all tenants keeps this proportional to the
 * number of pilots, which is small by definition.
 */
export async function reconcileLiveEvaluations(now = new Date()): Promise<number> {
  const evaluationPlans = await prisma.plan.findMany({
    where: { kind: { in: ["POC", "TRIAL"] } },
    select: { key: true, version: true },
  });
  if (evaluationPlans.length === 0) return 0;

  const subs = await prisma.subscription.findMany({
    where: {
      status: "ACTIVE",
      OR: evaluationPlans.map((p) => ({ planKey: p.key, planVersion: p.version })),
    },
    select: { billableEntityId: true, currentPeriodEnd: true },
  });

  let repaired = 0;
  for (const sub of subs) {
    // An evaluation already past its end is the expiry sweep's business, not
    // ours - granting it capabilities on the way out would be absurd.
    if (sub.currentPeriodEnd && sub.currentPeriodEnd.getTime() <= now.getTime()) continue;
    for (const tenantId of await tenantsForEntity(sub.billableEntityId)) {
      const r = await reconcileEvaluationCapabilities({ tenantId, actor: "billing-cycle" });
      if (r.granted.length > 0) {
        console.log(
          `[billing][cycle] granted ${r.granted.length} missing pilot capabilities to ${tenantId}: ${r.granted.join(", ")}`,
        );
        repaired += 1;
      }
    }
  }
  return repaired;
}
