/**
 * PendingCheckout - what the customer chose, frozen before they leave.
 *
 * The commercial terms are captured here and never re-derived afterwards. No
 * price, plan, credit figure or currency is ever accepted back from the browser
 * or from a provider callback: the callback carries only the opaque
 * `reference`, which is looked up server-side.
 *
 * That is the structural reason a browser redirect can never activate a
 * subscription. The redirect can at most tell us WHICH checkout the customer
 * came back from; whether it was paid is a separate, server-side question.
 */
import { assertPaymentCapability } from "../providers/icount-config";
import { randomBytes } from "crypto";
import { prisma } from "@chatcenter/shared";
import type { CheckoutStatus } from "@prisma/client";
import { checkoutEnabled, type ProviderCapabilities } from "../providers/capabilities";

/** How long a checkout may sit unpaid before it stops being honourable. */
const DEFAULT_TTL_MINUTES = 60;

export interface CreateCheckoutInput {
  tenantId?: string | null;
  signupContext?: Record<string, unknown> | null;
  planKey: string;
  planVersion: number;
  chatVolumeOptionKey?: string | null;
  voiceVolumeOptionKey?: string | null;
  /** SERVER-COMPUTED commercial snapshot. Never client-supplied. */
  snapshot: { price: number; currency: string; includedCredits: number };
  amount: number;
  currency: string;
  /** Only a Sysadmin trial/POC policy may set anything other than "none". */
  trialBehavior?: string;
  ttlMinutes?: number;
}

/**
 * An opaque, unguessable public reference.
 *
 * Deliberately carries no tenant, plan or price information: it travels through
 * a third party and a browser URL, so it must be useless to anyone who sees it
 * and impossible to enumerate.
 */
export function newCheckoutReference(): string {
  return `chk_${randomBytes(24).toString("base64url")}`;
}

/**
 * Open a checkout a customer can pay for themselves.
 *
 * This has NO callers today, and that is the current product position: nobody
 * buys without a human. Every live checkout is created by Sysadmin paid
 * provisioning instead (paid-provisioning.service), which is a deliberate
 * human decision per organization.
 *
 * The guard is here rather than on a public route because the route does not
 * exist yet. Wiring one up is exactly the change that would open self-service
 * purchase by accident, and this makes that change refuse rather than succeed
 * until someone sets the flag on purpose.
 */
export async function createPendingCheckout(input: CreateCheckoutInput) {
  if (String(process.env.SELF_SERVE_CHECKOUT_ENABLED || "").trim().toLowerCase() !== "true") {
    throw new SelfServeCheckoutDisabledError();
  }
  const reference = newCheckoutReference();
  const ttl = input.ttlMinutes ?? DEFAULT_TTL_MINUTES;

  return prisma.pendingCheckout.create({
    data: {
      reference,
      tenantId: input.tenantId ?? null,
      signupContext: (input.signupContext ?? undefined) as any,
      planKey: input.planKey,
      planVersion: input.planVersion,
      chatVolumeOptionKey: input.chatVolumeOptionKey ?? null,
      voiceVolumeOptionKey: input.voiceVolumeOptionKey ?? null,
      snapshotPrice: input.snapshot.price,
      snapshotCurrency: input.snapshot.currency,
      snapshotIncludedCredits: input.snapshot.includedCredits,
      amount: input.amount,
      currency: input.currency,
      trialBehavior: input.trialBehavior ?? "none",
      status: "PENDING",
      expiresAt: new Date(Date.now() + ttl * 60_000),
      // Deterministic: a replayed callback resolves to the same charge claim
      // rather than minting a new one.
      idempotencyKey: `checkout:${reference}`,
    },
  });
}

/** Look up by the opaque reference. The only lookup a callback may perform. */
export async function findByReference(reference: string) {
  if (!reference || !reference.startsWith("chk_")) return null;
  return prisma.pendingCheckout.findUnique({ where: { reference } });
}

/**
 * The commercial terms to charge.
 *
 * Reads the FROZEN snapshot, never the live plan. If the price changed while
 * the customer was on the payment page, they are charged what they agreed to.
 */
export function contractedTerms(checkout: {
  amount: unknown;
  currency: string;
  snapshotIncludedCredits: number;
}) {
  return {
    amount: Number(checkout.amount),
    currency: checkout.currency,
    includedCredits: checkout.snapshotIncludedCredits,
  };
}

/**
 * Whether this checkout may provision without a successful plan charge.
 *
 * Only an explicit Sysadmin trial/POC policy qualifies. A successful ₪1
 * tokenization is NOT payment, and must never be mistaken for one.
 */
export function mayProvisionWithoutCharge(checkout: { trialBehavior: string }): boolean {
  return checkout.trialBehavior === "trial" || checkout.trialBehavior === "poc";
}

export async function markStatus(id: string, status: CheckoutStatus) {
  return prisma.pendingCheckout.update({ where: { id }, data: { status } });
}

/**
 * Guard for exposing checkout to customers at all.
 *
 * Requires BOTH that the provider can store a card and that we have a verified
 * way to learn, on the server, that it did. Missing the second is the state
 * that forces the only available success signal to be "the browser came back",
 * which proves the customer returned and nothing else.
 *
 * Both are verified for iCount today - the token is pulled with
 * client/get_cc_tokens - so this passes. It is called rather than merely
 * defined, because a guard nothing invokes is not a guard.
 */
export function assertCheckoutMayBeEnabled(caps: ProviderCapabilities): void {
  // Two different reasons checkout can be closed, and they are not the same
  // thing. This one is a product decision - self-service purchase is not open
  // yet - and it is checked first, because telling an operator their provider
  // lacks a capability when the real answer is "we have not switched it on"
  // sends them to fix the wrong system.
  assertPaymentCapability("checkout");

  if (!checkoutEnabled(caps)) {
    throw new CheckoutDisabledError();
  }
}

/** Distinct type so a caller can turn it into whatever its surface needs. */
/**
 * Self-service purchase is closed as a product decision.
 *
 * Deliberately NOT a CheckoutDisabledError. That one means the provider's
 * tokenization contract is unverified - a thing to go and fix. This one means
 * nobody is supposed to buy without a human yet, and there is nothing broken.
 */
export class SelfServeCheckoutDisabledError extends Error {
  readonly code = "self_serve_checkout_disabled";
  constructor() {
    super(
      "[billing] self-service checkout is disabled: every checkout is opened by Sysadmin " +
        "paid provisioning. Set SELF_SERVE_CHECKOUT_ENABLED=true to open it.",
    );
    this.name = "SelfServeCheckoutDisabledError";
  }
}

export class CheckoutDisabledError extends Error {
  readonly code = "payment_setup_unavailable";
  constructor() {
    super(
      "[billing] checkout is disabled: the provider's tokenization or token-retrieval contract is not verified, so tokenization success cannot be confirmed server-side",
    );
    this.name = "CheckoutDisabledError";
  }
}
