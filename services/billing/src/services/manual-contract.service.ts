/**
 * Manual external contract activation.
 *
 * For an organization that pays outside the product: bank transfer, a signed
 * agreement, an invoice settled by finance. No card, no provider, no charge.
 *
 * It deliberately reuses `activatePaidCheckout` rather than having its own
 * activation path. One place creates subscriptions and grants credits, so a
 * manual contract cannot drift from the rules a paid checkout obeys - the
 * amount still has to match the immutable snapshot, and credits are still
 * granted exactly once.
 *
 * What differs is provenance. The attempt records
 * `paymentSource = MANUAL_EXTERNAL_CONTRACT` plus the external reference and a
 * reason, so nothing downstream - billing history, an audit, a support
 * conversation - can present this as a card payment that actually cleared.
 */
import { prisma } from "@chatcenter/shared";
import { activatePaidCheckout } from "./checkout-activation.service";

export class ManualContractRefused extends Error {
  constructor(readonly code: string, detail?: string) {
    super(`[billing] manual contract refused: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "ManualContractRefused";
  }
}

export interface ActivateManualContractInput {
  tenantId: string;
  /** Must match the checkout snapshot exactly. */
  amount: number;
  currency: string;
  periodStart?: Date;
  periodEnd?: Date;
  /** Invoice number, agreement id, or similar. Required. */
  externalReference: string;
  /** "Bank transfer", "Annual agreement", etc. Required. */
  paymentSourceDescription: string;
  /** Why this is being activated without a provider payment. Required. */
  reason: string;
  actor?: string | null;
}

export interface ManualContractResult {
  activated: boolean;
  firstActivation: boolean;
  checkoutReference: string;
  paymentAttemptId: string;
}

/**
 * Activate a tenant's pending checkout as an externally settled contract.
 *
 * Requires an existing PendingCheckout. That is deliberate: the checkout holds
 * the immutable commercial snapshot, and activating without one would mean
 * inventing terms at activation time, with nothing recording what the customer
 * actually agreed to.
 */
export async function activateManualContract(
  input: ActivateManualContractInput,
): Promise<ManualContractResult> {
  for (const [field, value] of [
    ["externalReference", input.externalReference],
    ["paymentSourceDescription", input.paymentSourceDescription],
    ["reason", input.reason],
  ] as const) {
    if (!String(value ?? "").trim()) throw new ManualContractRefused("missing_required_field", field);
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: input.tenantId },
    select: { id: true, status: true },
  });
  if (!tenant) throw new ManualContractRefused("tenant_not_found");
  if (tenant.status !== "PENDING_PAYMENT") {
    throw new ManualContractRefused("tenant_not_pending_payment", tenant.status);
  }

  const checkout = await prisma.pendingCheckout.findFirst({
    where: { tenantId: input.tenantId, status: { in: ["PENDING", "AWAITING_PROVIDER", "TOKENIZED"] } },
    orderBy: { createdAt: "desc" },
  });
  if (!checkout) throw new ManualContractRefused("no_resumable_checkout");

  // The customer agreed to the snapshot. A different figure is a different
  // commercial offer and needs its own checkout, not an override here.
  if (Number(input.amount) !== Number(checkout.amount)) {
    throw new ManualContractRefused("amount_does_not_match_snapshot");
  }
  if (input.currency.toUpperCase() !== checkout.currency.toUpperCase()) {
    throw new ManualContractRefused("currency_does_not_match_snapshot");
  }

  // A deterministic key derived from the checkout, so a double-submit collides
  // on the unique index instead of activating twice.
  const attemptKey = `manual:${checkout.reference}`;

  let attempt = await prisma.paymentAttempt.findUnique({ where: { attemptKey } });
  if (!attempt) {
    try {
      attempt = await prisma.paymentAttempt.create({
        data: {
          attemptKey,
          checkoutId: checkout.id,
          tenantId: input.tenantId,
          purpose: "SUBSCRIPTION_INITIAL",
          amount: checkout.amount,
          currency: checkout.currency,
          // SUCCEEDED because the money genuinely arrived - just not through a
          // provider. No cc/bill was called and no Charge row is created, so
          // nothing claims an iCount transaction that does not exist.
          state: "SUCCEEDED",
          paymentSource: "MANUAL_EXTERNAL_CONTRACT",
          externalReference: input.externalReference,
          manualReason: input.reason,
          manualPaymentSource: input.paymentSourceDescription,
        },
      });
    } catch (err: any) {
      if (err?.code !== "P2002") throw err;
      attempt = await prisma.paymentAttempt.findUnique({ where: { attemptKey } });
      if (!attempt) throw err;
    }
  }

  if (attempt.paymentSource !== "MANUAL_EXTERNAL_CONTRACT") {
    // A provider attempt already exists for this checkout. Overwriting its
    // provenance would let a failed card payment be relabelled as settled.
    throw new ManualContractRefused("existing_attempt_is_not_manual");
  }

  const result = await activatePaidCheckout({
    checkoutId: checkout.id,
    paymentAttemptId: attempt.id,
    source: "MANUAL_EXTERNAL_CONTRACT",
    actor: input.actor ?? undefined,
  });

  return {
    activated: result.activated,
    firstActivation: result.firstActivation,
    checkoutReference: checkout.reference,
    paymentAttemptId: attempt.id,
  };
}

/** Manual contracts for a tenant, for billing history. */
export async function manualContractsForTenant(tenantId: string) {
  return prisma.paymentAttempt.findMany({
    where: { tenantId, paymentSource: "MANUAL_EXTERNAL_CONTRACT" },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      amount: true,
      currency: true,
      externalReference: true,
      manualPaymentSource: true,
      manualReason: true,
      state: true,
      consumedByActivationAt: true,
      createdAt: true,
    },
  });
}
