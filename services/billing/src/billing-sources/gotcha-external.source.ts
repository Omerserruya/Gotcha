/**
 * GOTCHA's own billing, expressed as a BillingSourceProvider.
 *
 * This is an ADAPTER, not a second implementation. Every behaviour it reports
 * is read from the state the existing services already own - `Subscription`,
 * `subscription.service.ts`, the PaymentProvider registry, `payg.service.ts`.
 * Nothing here charges anybody, and nothing here decides anything the existing
 * code was already deciding.
 *
 * Why it exists at all, given it adds no behaviour: without it, every caller
 * that wants to ask "what is true about this workspace's billing" would have to
 * branch - Shopify through the port, external through six different services -
 * and that branch would be copied into the entitlement path, the reconciliation
 * job, and the UI endpoint. One of those copies would eventually disagree with
 * the others. The adapter is what keeps `getBillingSource(x).fetchSubscription()`
 * a single question with a single answer.
 *
 * The deliberate non-implementation
 * ---------------------------------
 * `beginSubscription` returns `redirectUrl: null` rather than starting a
 * checkout. GOTCHA's external checkout is a multi-step journey - quote, hosted
 * tokenization, server-side verification, activation - owned by
 * `checkout.service.ts` and `tokenization.service.ts`, and it is entered from
 * the existing routes. Reimplementing its entry point here would be a second
 * way to start a checkout, which is exactly the "disconnected second billing
 * system" this work is meant to avoid.
 */
import { prisma } from "@chatcenter/shared";
import type { ProviderSubscriptionStatus, SubscriptionStatus } from "@prisma/client";
import { GOTCHA_EXTERNAL_CAPABILITIES } from "./capabilities";
import type {
  BeginSubscriptionInput,
  BeginSubscriptionResult,
  BillingSourceProvider,
  ObservedSubscription,
  ProviderSubscriptionRef,
} from "./source";

/**
 * Our own SubscriptionStatus, mapped into the provider-neutral vocabulary.
 *
 * SUSPENDED maps to PAST_DUE rather than FROZEN on purpose. They look similar
 * and are not: FROZEN is Shopify's "on hold, and Shopify will reactivate it
 * itself once the merchant pays", while SUSPENDED is ours for "dunning is
 * exhausted and a human has to act". Collapsing them would make a workspace
 * that needs intervention look like one that is quietly waiting to heal.
 *
 * GRANDFATHERED maps to ACTIVE because that is what it means for access. The
 * fact that it is grandfathered is carried by the subscription's own status and
 * by BillingPolicyDecision, not smuggled through this enum.
 */
const STATUS_MAP: Record<SubscriptionStatus, ProviderSubscriptionStatus> = {
  PENDING: "PENDING",
  TRIALING: "TRIALING",
  ACTIVE: "ACTIVE",
  PAST_DUE: "PAST_DUE",
  SUSPENDED: "PAST_DUE",
  CANCELED: "CANCELLED",
  PAUSED: "REQUIRES_ACTION",
  GRANDFATHERED: "ACTIVE",
};

export const gotchaExternalSource: BillingSourceProvider = {
  source: "GOTCHA_EXTERNAL",
  capabilities: GOTCHA_EXTERNAL_CAPABILITIES,

  async beginSubscription(_input: BeginSubscriptionInput): Promise<BeginSubscriptionResult> {
    // See the file header: the existing checkout owns this journey. Returning
    // null is the honest answer, not a stub - the caller is expected to send
    // the customer to GOTCHA's own checkout, which it already knows how to do.
    return { redirectUrl: null, externalId: null, status: "PENDING" };
  },

  async fetchSubscription(ref: ProviderSubscriptionRef): Promise<ObservedSubscription | null> {
    const sub = await prisma.subscription.findUnique({
      where: { billableEntityId: ref.billableEntityId },
      select: {
        id: true,
        status: true,
        planKey: true,
        trialEndsAt: true,
        currentPeriodStart: true,
        currentPeriodEnd: true,
        cancelAtPeriodEnd: true,
        billingSource: true,
      },
    });

    // No row means no subscription. That is an answer - "revoke" - and not a
    // reason to leave whatever was there before in place.
    if (!sub) return null;

    // A payer whose subscription is billed by somebody else is not this
    // source's to report on. Answering anyway would let an external reading
    // resurrect entitlements that Shopify has stopped paying for.
    if (sub.billingSource !== "GOTCHA_EXTERNAL") return null;

    return {
      externalId: sub.id,
      status: STATUS_MAP[sub.status],
      rawStatus: sub.status,
      planHandle: sub.planKey,
      trialEndsAt: sub.trialEndsAt,
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      metadata: {},
    };
  },
};
