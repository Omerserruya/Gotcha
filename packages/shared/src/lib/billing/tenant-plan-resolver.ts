/**
 * The database half of the tenant-commercial invariant.
 *
 * Reads the facts, hands them to the pure classifier in tenant-plan-access, and
 * returns the verdict. Every surface that needs to know whether an organization
 * has a plan - the request gate, the Sysadmin console, the audit - comes through
 * here, so none of them can drift into having its own idea of what counts.
 */
import { prisma } from "../prisma";
import {
  classifyTenantPlanAccess,
  subscriptionIsActiveSource,
  type PlanAccessVerdict,
  type PlanAccessSubscription,
} from "./tenant-plan-access";

/** Checkout states that mean "a paid plan was chosen and not yet paid for". */
const OPEN_CHECKOUT_STATES = ["PENDING", "AWAITING_PROVIDER", "TOKENIZED"];

/** Provisioning states that mean the request never finished. */
const UNFINISHED_PROVISIONING = ["PENDING", "PROCESSING", "FAILED_RETRYABLE", "FAILED_PERMANENT"];

function graceHours(): number {
  const raw = Number(process.env.BILLING_PAST_DUE_GRACE_HOURS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 72;
}

/**
 * Resolve one organization's commercial access.
 *
 * Fails CLOSED on a query error, unlike the entitlement gate, which fails open
 * on infrastructure so a database blip cannot cut off every paying customer
 * mid-conversation. The asymmetry is deliberate: this answers "does a plan
 * exist", and the honest answer when we cannot tell is that we cannot tell -
 * `unknown` is returned so the caller decides, rather than this file inventing
 * either a plan or a denial on a tenant's behalf.
 */
export async function resolveTenantPlanAccess(
  tenantId: string,
  opts: { now?: Date } = {},
): Promise<PlanAccessVerdict & { unknown?: true }> {
  let tenantStatus = "ACTIVE";
  let subscriptions: PlanAccessSubscription[] = [];
  let hasOpenCheckout = false;
  let provisioningIncomplete = false;
  let hasManualContract = false;

  try {
    const [tenant, links, checkout, request] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: tenantId }, select: { status: true } }),
      prisma.billableEntityTenant.findMany({
        where: { tenantId },
        include: { entity: { include: { subscription: true } } },
      }),
      prisma.pendingCheckout.findFirst({
        where: { tenantId, status: { in: OPEN_CHECKOUT_STATES as any } },
        select: { id: true },
      }),
      prisma.tenantBillingProvisioningRequest.findFirst({
        where: { tenantId, state: { in: UNFINISHED_PROVISIONING as any } },
        select: { id: true },
      }),
    ]);

    if (!tenant) {
      return {
        active: false,
        source: "NONE",
        state: "MISSING",
        label: "Missing plan, requires action",
        planKey: null,
        planName: null,
        expiresAt: null,
        subscriptionId: null,
        needsReview: true,
        reviewReason: "no_plan",
      };
    }

    tenantStatus = tenant.status;
    hasOpenCheckout = !!checkout;
    provisioningIncomplete = !!request;

    const subs = links.map((l) => l.entity.subscription).filter(Boolean) as NonNullable<
      (typeof links)[number]["entity"]["subscription"]
    >[];

    // The plan row carries the KIND, which is what separates a POC from a paid
    // plan. Resolved per subscription rather than assumed from the key, because
    // the key is operator-chosen text and the kind is the schema's answer.
    const plans = subs.length
      ? await prisma.plan.findMany({
          where: { OR: subs.map((s) => ({ key: s.planKey, version: s.planVersion })) },
          select: { key: true, version: true, kind: true, name: true },
        })
      : [];
    const planBy = new Map(plans.map((p) => [`${p.key}@${p.version}`, p]));

    subscriptions = subs.map((s) => {
      const plan = planBy.get(`${s.planKey}@${s.planVersion}`);
      return {
        id: s.id,
        planKey: s.planKey,
        planVersion: s.planVersion,
        status: s.status,
        planKind: plan?.kind ?? null,
        planName: plan?.name ?? null,
        enforcementEnabled: s.enforcementEnabled,
        trialEndsAt: s.trialEndsAt,
        currentPeriodEnd: s.currentPeriodEnd,
      };
    });

    if (subscriptions.length) {
      const manual = await prisma.paymentAttempt.findFirst({
        where: { tenantId, paymentSource: "MANUAL_EXTERNAL_CONTRACT", state: "SUCCEEDED" },
        select: { id: true },
      });
      hasManualContract = !!manual;
    }
  } catch (err) {
    // Do not guess. A caller that must decide something now knows the answer is
    // unavailable and can apply its own rule.
    return {
      active: false,
      source: "NONE",
      state: "MISSING",
      label: "Plan state unavailable",
      planKey: null,
      planName: null,
      expiresAt: null,
      subscriptionId: null,
      needsReview: false,
      unknown: true,
    };
  }

  return classifyTenantPlanAccess({
    tenantStatus,
    subscriptions,
    hasOpenCheckout,
    provisioningIncomplete,
    hasManualContract,
    pastDueGraceHours: graceHours(),
    now: opts.now,
  });
}

/**
 * The two facts the request gate needs, at the cost the request path can bear.
 *
 * The full resolver answers a richer question - which source, expiring when,
 * what should an operator do - and pays six queries for it. That is right for a
 * console screen and wrong for something on the path of every request to the
 * product, so this answers only "may they use it" and "is payment the reason",
 * in one query for the common case and two when there is no subscription.
 *
 * It delegates the actual rule to `subscriptionIsActiveSource`, the same
 * function the classifier and the audit use. A faster second opinion about who
 * is entitled would be exactly the kind of drift that ends with the console
 * showing one thing and the gate doing another.
 */
export async function tenantPlanGateFacts(
  tenantId: string,
  opts: { now?: Date } = {},
): Promise<{ active: boolean; pendingPayment: boolean; unknown?: true }> {
  const now = opts.now ?? new Date();
  const grace = graceHours();

  try {
    const link = await prisma.billableEntityTenant.findUnique({
      where: { tenantId },
      include: { entity: { include: { subscription: true } } },
    });
    const sub = link?.entity.subscription;

    if (sub) {
      const expired = !!sub.currentPeriodEnd && sub.currentPeriodEnd <= now;
      // The plan's KIND only matters once the period has passed - it is what
      // separates "a paid subscription between periods" from "an evaluation
      // that has ended". Fetching it on every request to learn that would be
      // paying for the rare case in the common one.
      const planKind = expired
        ? (
            await prisma.plan.findUnique({
              where: { key_version: { key: sub.planKey, version: sub.planVersion } },
              select: { kind: true },
            })
          )?.kind ?? null
        : null;

      const active = subscriptionIsActiveSource(
        {
          planKey: sub.planKey,
          planVersion: sub.planVersion,
          status: sub.status,
          planKind,
          trialEndsAt: sub.trialEndsAt,
          currentPeriodEnd: sub.currentPeriodEnd,
        },
        now,
        grace,
      );
      if (active) return { active: true, pendingPayment: false };
    }

    const checkout = await prisma.pendingCheckout.findFirst({
      where: { tenantId, status: { in: OPEN_CHECKOUT_STATES as any } },
      select: { id: true },
    });
    return { active: false, pendingPayment: !!checkout };
  } catch {
    // Unreadable, not absent. Denying the product to every paying organization
    // because of a database blip is the worse failure of the two.
    return { active: false, pendingPayment: false, unknown: true };
  }
}

/**
 * The same verdict for many organizations, in a fixed number of queries.
 *
 * Exists so the console and the estate audit cannot answer this question
 * differently from the request gate just because they had to answer it in bulk.
 * A per-tenant loop over `resolveTenantPlanAccess` would be the same rules but
 * N times the queries, and the first person to notice would fix it by writing a
 * second, faster, subtly different implementation.
 *
 * `tenantIds` omitted means every tenant.
 */
export async function resolveTenantPlanAccessBatch(
  tenantIds?: string[],
  opts: { now?: Date } = {},
): Promise<Map<string, PlanAccessVerdict>> {
  const scope = tenantIds ? { tenantId: { in: tenantIds } } : {};
  const tenantScope = tenantIds ? { id: { in: tenantIds } } : {};

  const [tenants, links, checkouts, requests, manualAttempts] = await Promise.all([
    prisma.tenant.findMany({ where: tenantScope, select: { id: true, status: true } }),
    prisma.billableEntityTenant.findMany({
      where: scope,
      include: { entity: { include: { subscription: true } } },
    }),
    prisma.pendingCheckout.findMany({
      where: { ...scope, status: { in: OPEN_CHECKOUT_STATES as any } },
      select: { tenantId: true },
    }),
    prisma.tenantBillingProvisioningRequest.findMany({
      where: { ...scope, state: { in: UNFINISHED_PROVISIONING as any } },
      select: { tenantId: true },
    }),
    prisma.paymentAttempt.findMany({
      where: { ...scope, paymentSource: "MANUAL_EXTERNAL_CONTRACT", state: "SUCCEEDED" },
      select: { tenantId: true },
    }),
  ]);

  const subs = links.map((l) => l.entity.subscription).filter(Boolean) as NonNullable<
    (typeof links)[number]["entity"]["subscription"]
  >[];
  const plans = subs.length
    ? await prisma.plan.findMany({
        where: { OR: subs.map((s) => ({ key: s.planKey, version: s.planVersion })) },
        select: { key: true, version: true, kind: true, name: true },
      })
    : [];
  const planBy = new Map(plans.map((p) => [`${p.key}@${p.version}`, p]));

  const subsByTenant = new Map<string, PlanAccessSubscription[]>();
  for (const link of links) {
    const sub = link.entity.subscription;
    if (!sub) continue;
    const plan = planBy.get(`${sub.planKey}@${sub.planVersion}`);
    const list = subsByTenant.get(link.tenantId) ?? [];
    list.push({
      id: sub.id,
      planKey: sub.planKey,
      planVersion: sub.planVersion,
      status: sub.status,
      planKind: plan?.kind ?? null,
      planName: plan?.name ?? null,
      enforcementEnabled: sub.enforcementEnabled,
      trialEndsAt: sub.trialEndsAt,
      currentPeriodEnd: sub.currentPeriodEnd,
    });
    subsByTenant.set(link.tenantId, list);
  }

  const openCheckout = new Set(checkouts.map((c) => c.tenantId));
  const unfinished = new Set(requests.map((r) => r.tenantId));
  const manual = new Set(manualAttempts.map((a) => a.tenantId));
  const grace = graceHours();

  return new Map(
    tenants.map((t) => [
      t.id,
      classifyTenantPlanAccess({
        tenantStatus: t.status,
        subscriptions: subsByTenant.get(t.id) ?? [],
        hasOpenCheckout: openCheckout.has(t.id),
        provisioningIncomplete: unfinished.has(t.id),
        hasManualContract: manual.has(t.id),
        pastDueGraceHours: grace,
        now: opts.now,
      }),
    ]),
  );
}
