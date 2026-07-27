/**
 * Paid-tenant provisioning: everything a paid tenant needs EXCEPT a
 * subscription.
 *
 * The shape of the thing being defended against here is a tenant that gets the
 * product before it pays. So this creates the billing scaffolding and stops:
 * BillableEntity, an immutable PendingCheckout, a PENDING PaymentAttempt that
 * is prepared but never claimed, and one continuation link. It creates no
 * subscription, grants no credits, enables no entitlements, and makes no
 * provider call of any kind.
 *
 * Every commercial number is recomputed here from the catalog by the canonical
 * pricing engine. Prices, credits, currency and totals from the client are not
 * merely ignored - they are rejected, so a caller cannot discover that sending
 * them does nothing and keep sending them.
 */
import { prisma, toDecimalString } from "@chatcenter/shared";
import { quote } from "./pricing.service";
import { ensureBillableEntity } from "./billable-entity.service";
import { issueContinuationLink, type IssuedLink } from "./continuation-link.service";

export class ProvisioningRefused extends Error {
  constructor(readonly code: string, detail?: string) {
    super(`[billing] paid provisioning refused: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "ProvisioningRefused";
  }
}

/** Fields a client must never send. Presence is an error, not a no-op. */
const CLIENT_SUPPLIED_MONEY = [
  "price", "amount", "total", "credits", "includedCredits", "currency",
  "snapshotPrice", "snapshotCurrency", "snapshotIncludedCredits", "monthlyPrice",
] as const;

export interface ProvisionPaidTenantInput {
  tenantId: string;
  planVersionId: string;
  chatVolumeOptionKey?: string | null;
  voiceVolumeOptionKey?: string | null;
  billingInterval?: string;
  commercialNote?: string | null;
  actor?: string | null;
  /** Raw request body, checked for smuggled commercial values. */
  rawRequest?: Record<string, unknown>;
}

export interface ProvisionPaidTenantResult {
  checkoutId: string;
  checkoutReference: string;
  paymentAttemptId: string;
  billableEntityId: string;
  /** Raw token: for the immediate email boundary only. Never persisted. */
  link: IssuedLink;
  /** Safe commercial summary, computed server-side. */
  summary: {
    planKey: string;
    planVersion: number;
    planName: string;
    includedCredits: number;
    amount: string;
    currency: string;
    billingInterval: string;
    estimatedChatsMonthly: number;
    estimatedCallsMonthly: number;
    expiresAt: Date;
  };
}

/**
 * Reject any attempt to supply commercial values from outside.
 *
 * Silently ignoring them would be almost as bad: a caller would keep sending a
 * price, and the next person to read the code would reasonably assume it was
 * used.
 */
export function assertNoClientSuppliedCommercials(raw: Record<string, unknown> | undefined): void {
  if (!raw) return;
  for (const field of CLIENT_SUPPLIED_MONEY) {
    if (raw[field] !== undefined) {
      throw new ProvisioningRefused("client_supplied_commercial_value", field);
    }
  }
}

/**
 * Validate the plan and volume selection.
 *
 * Exported so the route can validate before creating a tenant: provisioning
 * that fails on plan validation must not leave a tenant behind.
 */
export async function resolveAndValidatePlan(input: {
  planVersionId: string;
  chatVolumeOptionKey?: string | null;
  voiceVolumeOptionKey?: string | null;
  billingInterval?: string;
}) {
  const plan = await prisma.plan.findUnique({ where: { id: input.planVersionId } });
  if (!plan) throw new ProvisioningRefused("plan_version_not_found");

  // Only an ACTIVE version may be sold. DRAFT is unpublished, RETIRED is a
  // version existing customers keep but new ones must not join.
  if (plan.status !== "ACTIVE") {
    throw new ProvisioningRefused("plan_version_not_active", plan.status);
  }
  if (plan.salesOnly) {
    // Sales-only plans have no published price; they go through the custom
    // path, which is not part of this slice.
    throw new ProvisioningRefused("plan_version_not_selectable", "salesOnly");
  }
  // PAID_PLAN provisions from the public catalog only. CUSTOM, POC and TRIAL
  // each have their own explicit path with their own rules, and routing them
  // through here would apply the wrong ones.
  if (plan.kind !== "PUBLIC") {
    throw new ProvisioningRefused("plan_version_not_public", plan.kind);
  }
  // A plan scoped to one organization must never be sellable to another.
  if (plan.tenantId) {
    throw new ProvisioningRefused("plan_version_belongs_to_another_organization");
  }
  if (input.billingInterval && input.billingInterval !== plan.billingInterval) {
    throw new ProvisioningRefused("billing_interval_mismatch", input.billingInterval);
  }

  // Volume options must belong to THIS plan version. Accepting a key from
  // another plan would price a selection the customer cannot actually have.
  for (const [channel, key] of [
    ["CHAT", input.chatVolumeOptionKey],
    ["VOICE", input.voiceVolumeOptionKey],
  ] as const) {
    if (!key) continue;
    const enabled = channel === "CHAT" ? plan.chatVolumeEnabled : plan.voiceVolumeEnabled;
    if (!enabled) throw new ProvisioningRefused("volume_option_not_enabled", channel);
    const option = await prisma.planVolumeOption.findFirst({
      where: { planId: plan.id, channel, key, enabled: true },
    });
    if (!option) throw new ProvisioningRefused("volume_option_invalid", `${channel}:${key}`);
  }

  return plan;
}

/**
 * Create the billing scaffolding for a paid tenant.
 *
 * The tenant and its identity already exist; this adds everything billing owns.
 */
export async function provisionPaidTenant(
  input: ProvisionPaidTenantInput,
): Promise<ProvisionPaidTenantResult> {
  assertNoClientSuppliedCommercials(input.rawRequest);

  const plan = await resolveAndValidatePlan(input);

  // THE authoritative calculation. Option keys in, every number out.
  const q = await quote({
    planKey: plan.key,
    planVersion: plan.version,
    chatVolumeOptionKey: input.chatVolumeOptionKey ?? null,
    voiceVolumeOptionKey: input.voiceVolumeOptionKey ?? null,
    tenantId: input.tenantId,
  });

  const entityId = await ensureBillableEntity(input.tenantId);
  const reference = `chk_${(await import("crypto")).randomBytes(24).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + Number(process.env.PAYMENT_LINK_TTL_HOURS || 72) * 3_600_000);

  const created = await prisma.$transaction(async (tx) => {
    const checkout = await tx.pendingCheckout.create({
      data: {
        reference,
        tenantId: input.tenantId,
        planKey: q.planKey,
        planVersion: q.planVersion,
        chatVolumeOptionKey: q.chatVolumeOptionKey,
        voiceVolumeOptionKey: q.voiceVolumeOptionKey,
        snapshotPrice: toDecimalString(q.monthlyPrice),
        snapshotCurrency: q.currency,
        snapshotIncludedCredits: q.includedCredits,
        amount: toDecimalString(q.monthlyPrice),
        currency: q.currency,
        // Sysadmin-provisioned paid tenants pay first, always. Trial and POC
        // have their own explicit paths.
        trialBehavior: "none",
        status: "PENDING",
        expiresAt,
        idempotencyKey: `checkout:${reference}`,
      },
    });

    // Prepared, never claimed. No execution owner, no provider request, no
    // token: this row exists so the eventual charge has a unique identity
    // before anything can race for it.
    const attempt = await tx.paymentAttempt.create({
      data: {
        attemptKey: `checkout:${reference}:initial`,
        checkoutId: checkout.id,
        tenantId: input.tenantId,
        purpose: "SUBSCRIPTION_INITIAL",
        amount: toDecimalString(q.monthlyPrice),
        currency: q.currency,
        state: "PENDING",
      },
    });

    return { checkout, attempt };
  });

  const link = await issueContinuationLink({
    checkoutId: created.checkout.id,
    tenantId: input.tenantId,
    createdBy: input.actor ?? null,
  });

  return {
    checkoutId: created.checkout.id,
    checkoutReference: created.checkout.reference,
    paymentAttemptId: created.attempt.id,
    billableEntityId: entityId,
    link,
    summary: {
      planKey: q.planKey,
      planVersion: q.planVersion,
      planName: plan.name,
      includedCredits: q.includedCredits,
      amount: toDecimalString(q.monthlyPrice),
      currency: q.currency,
      billingInterval: plan.billingInterval,
      estimatedChatsMonthly: q.estimate.chat.monthly,
      estimatedCallsMonthly: q.estimate.voice.monthly,
      expiresAt: link.expiresAt,
    },
  };
}
