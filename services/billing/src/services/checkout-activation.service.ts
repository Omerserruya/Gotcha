/**
 * The single place a paid checkout becomes a live subscription.
 *
 * Nothing else in the system may activate a paid plan. In particular there is
 * deliberately NO browser-callable "complete checkout" endpoint: a redirect can
 * say which checkout the customer came back from, never that it was paid.
 *
 * Every invariant below is checked before anything is written, and the write
 * itself is one transaction. The ordering matters: cheap identity checks first,
 * money checks second, then the idempotency guard, so a mismatched request is
 * rejected before it can touch subscription state.
 */
import { prisma, materializeEntitlements, rolloverIncluded } from "@chatcenter/shared";
import type { PaymentAttempt, PendingCheckout } from "@prisma/client";
import { currentPeriod } from "../lib/period";

/**
 * How the payment was proven.
 *
 * MANUAL_EXTERNAL_CONTRACT exists so a Sysadmin-activated contract can never be
 * mistaken, in billing history or in an audit, for a card payment that
 * actually cleared through the provider.
 */
export type PaymentSource = "PROVIDER_CONFIRMED" | "MANUAL_EXTERNAL_CONTRACT";

export class ActivationRefused extends Error {
  constructor(readonly code: string, detail?: string) {
    super(`[billing] activation refused: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "ActivationRefused";
  }
}

export interface ActivateResult {
  activated: boolean;
  /** True when this call did the work; false when it was already done. */
  firstActivation: boolean;
  subscriptionId?: string;
}

/**
 * Activate a paid checkout against a CONFIRMED payment attempt.
 *
 * Refuses unless every one of these holds:
 *   - the checkout exists and is not already COMPLETED, EXPIRED or CANCELED
 *   - the attempt belongs to this checkout
 *   - the tenant matches
 *   - the amount matches the immutable snapshot exactly
 *   - the currency matches
 *   - the attempt state is SUCCEEDED
 *   - the attempt has not already been consumed by an activation
 *
 * PENDING, UNKNOWN, RECONCILIATION_REQUIRED and MANUAL_REVIEW all fail. UNKNOWN
 * is the important one: "we might have been paid" is not payment, and treating
 * it as such would hand out a paid plan for a charge that may never have
 * landed.
 */
export async function activatePaidCheckout(args: {
  checkoutId: string;
  paymentAttemptId: string;
  source?: PaymentSource;
  actor?: string;
}): Promise<ActivateResult> {
  const source = args.source ?? "PROVIDER_CONFIRMED";

  const checkout = await prisma.pendingCheckout.findUnique({ where: { id: args.checkoutId } });
  if (!checkout) throw new ActivationRefused("checkout_not_found");

  const attempt = await prisma.paymentAttempt.findUnique({ where: { id: args.paymentAttemptId } });
  if (!attempt) throw new ActivationRefused("attempt_not_found");

  assertActivatable(checkout, attempt);

  // Idempotency: a checkout already COMPLETED is a no-op, not an error and not
  // a second grant of credits.
  if (checkout.status === "PAID") {
    return { activated: true, firstActivation: false };
  }

  const period = currentPeriod(new Date());
  const entityId = await resolveEntityId(checkout.tenantId!);

  const result = await prisma.$transaction(async (tx) => {
    // Consume the attempt FIRST, conditionally. If another worker got here
    // first this updates zero rows and we abort, so credits are granted once
    // even under concurrent activation.
    const consumed = await tx.paymentAttempt.updateMany({
      where: { id: attempt.id, state: "SUCCEEDED", consumedByActivationAt: null },
      data: { consumedByActivationAt: new Date() },
    });
    if (consumed.count !== 1) return { raced: true as const };

    const subscription = await tx.subscription.upsert({
      where: { billableEntityId: entityId },
      create: {
        billableEntityId: entityId,
        planKey: checkout.planKey,
        planVersion: checkout.planVersion,
        status: "ACTIVE",
        enforcementEnabled: true,
        currentPeriodStart: period.start,
        currentPeriodEnd: period.end,
        billingInterval: "MONTHLY",
        snapshotPrice: checkout.snapshotPrice,
        snapshotCurrency: checkout.snapshotCurrency,
        snapshotIncludedCredits: checkout.snapshotIncludedCredits,
        chatVolumeOptionKey: checkout.chatVolumeOptionKey,
        voiceVolumeOptionKey: checkout.voiceVolumeOptionKey,
      },
      update: {
        status: "ACTIVE",
        planKey: checkout.planKey,
        planVersion: checkout.planVersion,
        currentPeriodStart: period.start,
        currentPeriodEnd: period.end,
        snapshotPrice: checkout.snapshotPrice,
        snapshotCurrency: checkout.snapshotCurrency,
        snapshotIncludedCredits: checkout.snapshotIncludedCredits,
      },
    });

    await tx.pendingCheckout.update({ where: { id: checkout.id }, data: { status: "PAID" } });
    await tx.tenant.update({ where: { id: checkout.tenantId! }, data: { status: "ACTIVE" } });

    await tx.subscriptionEvent.create({
      data: {
        subscriptionId: subscription.id,
        type: source === "MANUAL_EXTERNAL_CONTRACT" ? "manual_contract_activated" : "checkout_activated",
        fromStatus: null,
        toStatus: "ACTIVE",
        actor: args.actor ?? "system",
        metadata: { source, checkoutId: checkout.id, paymentAttemptId: attempt.id } as any,
      },
    });

    return { raced: false as const, subscriptionId: subscription.id };
  });

  if (result.raced) return { activated: true, firstActivation: false };

  // Credits and entitlements land AFTER the transaction commits, and only on
  // the call that won the consume - so a duplicate activation grants neither.
  await rolloverIncluded(
    checkout.tenantId!,
    period.key,
    checkout.snapshotIncludedCredits,
    period.end,
    `checkout:${checkout.reference}`,
  );
  await materializeEntitlements(checkout.tenantId!, args.actor);

  return { activated: true, firstActivation: true, subscriptionId: result.subscriptionId };
}

/** Every refusal reason, in one place so the rules are readable together. */
export function assertActivatable(checkout: PendingCheckout, attempt: PaymentAttempt): void {
  if (!checkout.tenantId) throw new ActivationRefused("checkout_has_no_tenant");

  if (checkout.status === "EXPIRED") throw new ActivationRefused("checkout_expired");
  if (checkout.status === "CANCELED") throw new ActivationRefused("checkout_canceled");
  if (checkout.status === "FAILED") throw new ActivationRefused("checkout_failed");

  if (attempt.checkoutId !== checkout.id) {
    throw new ActivationRefused("attempt_not_for_this_checkout");
  }
  if (attempt.tenantId && attempt.tenantId !== checkout.tenantId) {
    throw new ActivationRefused("tenant_mismatch");
  }

  // Money must match the frozen snapshot EXACTLY. A near-miss is a bug
  // somewhere upstream, and activating on it would give away the difference.
  if (Number(attempt.amount) !== Number(checkout.amount)) {
    throw new ActivationRefused("amount_mismatch");
  }
  if (attempt.currency.toUpperCase() !== checkout.currency.toUpperCase()) {
    throw new ActivationRefused("currency_mismatch");
  }

  if (attempt.state !== "SUCCEEDED") {
    // UNKNOWN / RECONCILIATION_REQUIRED / MANUAL_REVIEW land here too:
    // "we might have been paid" is not payment.
    throw new ActivationRefused("attempt_not_succeeded", attempt.state);
  }
  if (attempt.consumedByActivationAt) {
    throw new ActivationRefused("attempt_already_consumed");
  }
}

async function resolveEntityId(tenantId: string): Promise<string> {
  const link = await prisma.billableEntityTenant.findUnique({ where: { tenantId } });
  if (!link) throw new ActivationRefused("no_billable_entity");
  return link.billableEntityId;
}
