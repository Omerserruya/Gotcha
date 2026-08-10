/**
 * Invoice + charge orchestration. Creates a thin Invoice record, runs an
 * idempotent charge through the provider, and (for iCount) records the legal
 * tax-document reference. The iCount-issued doc is the authoritative record;
 * our Invoice row is a mirror for in-app display + history.
 */
import { prisma, decryptPaymentToken } from "@chatcenter/shared";
import { taxForProfile } from "./tax.service";
import { createDocument, emailDocument } from "../providers/icount-client";
import type { BillingProvider, InvoiceType } from "@prisma/client";
import { getProvider } from "../providers";
import { assertChargeable, consumeQuote, createPaymentQuote, type QuotePurpose } from "./payment-quote.service";
import { emitBillingEvent } from "../lib/events";

/**
 * חשבונית מס קבלה - the document that is both the tax invoice and the receipt.
 * Confirmed against the account's own doc/types, which lists it as "invrec".
 */
const TAX_DOCTYPE = "invrec";

export interface ChargeForInput {
  entityId: string;
  tenantId: string;
  type: InvoiceType;
  amount: number;
  currency?: string;
  description: string;
  /** Stable key so retries never double-charge. */
  idempotencyKey: string;
  attemptNumber?: number;
}

export interface ChargeForResult {
  success: boolean;
  invoiceId: string;
  failureCode?: string;
  /**
   * The charge may or may not have gone through.
   *
   * Callers must branch on this before doing anything a failure would trigger.
   * Dunning in particular retries failures, and retrying a charge that landed
   * takes the money twice - so an unknown is deliberately NOT a failure with a
   * different message, it is a different outcome.
   */
  outcomeUnknown?: boolean;
}

/** Resolve the entity's payment context (provider + default token + profile). */
async function paymentContext(entityId: string): Promise<{
  provider: BillingProvider;
  token?: string;
  providerCustomerId?: string;
  currency: string;
  customer: { email?: string; vatId?: string };
  /** Who the document is made out to, and where they are liable. */
  identity: {
    billingName: string | null;
    billingCountry: string | null;
    billingAddress: string | null;
  };
  /** Shown on the document so the payment line names the card that paid. */
  card: { brand: string | null; last4: string | null };
} | null> {
  const profile = await prisma.billingProfile.findUnique({
    where: { billableEntityId: entityId },
    include: { paymentMethods: { where: { status: "ACTIVE" }, orderBy: { isDefault: "desc" } } },
  });
  if (!profile) return null;
  const pm = profile.paymentMethods[0];
  return {
    provider: profile.provider,
    token: pm?.token,
    providerCustomerId: profile.providerCustomerId ?? undefined,
    currency: profile.currency,
    customer: { email: profile.billingEmail ?? undefined, vatId: profile.vatId ?? undefined },
    identity: {
      billingName: profile.billingName ?? null,
      billingCountry: profile.billingCountry ?? null,
      billingAddress: profile.billingAddress ?? null,
    },
    card: { brand: pm?.brand ?? null, last4: pm?.last4 ?? null },
  };
}

/**
 * Where the receipt is sent.
 *
 * The billing email is the answer whenever there is one - it is the address
 * somebody chose for this. When there is not, the receipt still has to reach a
 * person, so it falls back to an admin of the tenant being billed rather than
 * going nowhere: a document nobody receives is, to the customer, a payment
 * with no proof.
 *
 * Returns null only when there is genuinely no one to send to, which the
 * caller records rather than swallows.
 */
async function receiptRecipient(billingEmail: string | undefined, tenantId: string): Promise<string | null> {
  const declared = String(billingEmail ?? "").trim();
  if (declared) return declared;

  const admin = await prisma.user.findFirst({
    where: { tenantId, role: "ADMIN", isActive: true },
    orderBy: { createdAt: "asc" },
    select: { email: true },
  });
  return admin?.email?.trim() || null;
}

/**
 * Charge the entity's default payment method for `amount`, recording an Invoice
 * + Charge and (on success) the iCount tax-doc reference. Idempotent on
 * `idempotencyKey` (a duplicate returns the prior Charge's outcome).
 */
export async function chargeFor(input: ChargeForInput): Promise<ChargeForResult> {
  const ctx = await paymentContext(input.entityId);
  const currency = input.currency || ctx?.currency || "ILS";

  // Atomically CLAIM the idempotency key BEFORE touching the provider. We create
  // the Invoice + a PENDING Charge in one transaction; the Charge's UNIQUE
  // idempotencyKey is the concurrency guard. If a sibling request already
  // claimed it, the create throws P2002, the whole tx rolls back (no orphan
  // invoice), and we return the existing charge's outcome - so the provider is
  // hit AT MOST ONCE per key even under concurrent calls / retries.
  let invoiceId: string;
  let chargeId: string;
  try {
    const claim = await prisma.$transaction(async (tx) => {
      const inv = await tx.invoice.create({
        data: {
          billableEntityId: input.entityId,
          provider: ctx?.provider ?? "ICOUNT",
          type: input.type,
          amount: input.amount.toFixed(2),
          currency,
          status: "DRAFT",
          lineItems: [{ description: input.description, amount: input.amount }],
        },
      });
      const chg = await tx.charge.create({
        data: { invoiceId: inv.id, provider: ctx?.provider ?? "ICOUNT", amount: input.amount.toFixed(2), currency, status: "PENDING", attemptNumber: input.attemptNumber ?? 1, idempotencyKey: input.idempotencyKey },
      });
      return { invoiceId: inv.id, chargeId: chg.id };
    });
    invoiceId = claim.invoiceId;
    chargeId = claim.chargeId;
  } catch (err: any) {
    if (err?.code === "P2002") {
      const prior = await prisma.charge.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (prior) {
        const inProgress = prior.status === "PENDING";
        return {
          success: prior.status === "SUCCEEDED",
          invoiceId: prior.invoiceId,
          failureCode: prior.failureCode ?? (inProgress ? "charge_in_progress" : undefined),
          // A charge still in flight, or one whose outcome was never learned,
          // must not be retried by whoever finds it.
          outcomeUnknown: inProgress || prior.status === "UNKNOWN",
        };
      }
    }
    throw err;
  }
  const invoice = { id: invoiceId };

  if (!ctx?.token) {
    await prisma.charge.update({
      where: { id: chargeId },
      data: { status: "FAILED", failureCode: "no_payment_method" },
    });
    await prisma.invoice.update({ where: { id: invoice.id }, data: { status: "FAILED" } });
    await emitBillingEvent({ type: "payment.failed", tenantId: input.tenantId, data: { invoiceId: invoice.id, reason: "no_payment_method", amount: input.amount } });
    return { success: false, invoiceId: invoice.id, failureCode: "no_payment_method" };
  }

  // Freeze the conversion. This is the renewal and credit-purchase path, so it
  // needs its own quote per charge: a renewal twelve months from now must be
  // converted at the rate in force THEN, and recorded with it, or the customer's
  // statement and our invoice will not agree.
  let quote;
  try {
    quote = await createPaymentQuote({
      purpose: quotePurposeFor(input.type),
      commercialAmount: input.amount.toFixed(2),
      commercialCurrency: currency,
      tenantId: input.tenantId ?? null,
      now: new Date(),
    });
    assertChargeable(quote);
  } catch (err: any) {
    // No approved rate means no defensible number to charge. Fail the charge
    // rather than inventing one; dunning will retry once a rate is approved.
    const code = `charge_not_priceable: ${err?.code ?? err?.message ?? "unknown"}`;
    await prisma.charge.update({ where: { id: chargeId }, data: { status: "FAILED", failureCode: code } });
    await prisma.invoice.update({ where: { id: invoice.id }, data: { status: "FAILED" } });
    await emitBillingEvent({
      type: "payment.failed",
      tenantId: input.tenantId,
      data: { invoiceId: invoice.id, reason: code, amount: input.amount },
    });
    return { success: false, invoiceId: invoice.id, failureCode: code };
  }

  const netAmount = quote.chargeAmount.toFixed(2);

  // Tax is computed in the currency it is owed in, on the CONVERTED net. Doing
  // it before conversion would leave net + tax failing to equal the gross after
  // two roundings, and a document whose three numbers do not add up is worse
  // than no document.
  let taxed;
  try {
    taxed = await taxForProfile(netAmount, { billingCountry: ctx.identity.billingCountry });
  } catch (err: any) {
    // No declared country means no defensible tax figure. Refusing is the
    // point: charging net would leave an Israeli customer owing VAT nobody
    // collected. Same shape as refusing without an approved FX rate.
    const code = `charge_not_taxable: ${err?.code ?? err?.message ?? "unknown"}`;
    await prisma.charge.update({ where: { id: chargeId }, data: { status: "FAILED", failureCode: code } });
    await prisma.invoice.update({ where: { id: invoice.id }, data: { status: "FAILED" } });
    await emitBillingEvent({
      type: "payment.failed",
      tenantId: input.tenantId,
      data: { invoiceId: invoice.id, reason: code, amount: input.amount },
    });
    return { success: false, invoiceId: invoice.id, failureCode: code };
  }

  // What actually leaves the card.
  const chargeAmount = taxed.gross;

  // Recorded BEFORE the request, so a crash mid-flight leaves a row saying what
  // was going to be submitted.
  await prisma.charge.update({
    where: { id: chargeId },
    data: {
      paymentQuoteId: quote.id,
      chargeAmount: taxed.gross,
      netAmount: taxed.net,
      taxPercent: taxed.percent,
      taxAmount: taxed.tax,
      chargeCurrency: quote.chargeCurrency,
      providerCurrencyId: quote.providerCurrencyId,
      fxRate: quote.fxRate,
      fxRateVersion: quote.fxRateVersion,
    },
  });
  await consumeQuote({ quoteId: quote.id, attemptId: chargeId });

  const provider = getProvider(ctx.provider);
  let result;
  try {
    result = await provider.charge({
    // Decrypted at the last possible moment, immediately before the provider
    // call, and never held anywhere a DTO, log or audit event can reach.
    // A token that cannot be decrypted fails the charge loudly rather than
    // being silently replaced or dropped.
    token: decryptPaymentToken(ctx.token),
    providerCustomerId: ctx.providerCustomerId,
    amount: input.amount,
    currency,
    chargeAmount,
    chargeCurrency: quote.chargeCurrency,
    providerCurrencyId: quote.providerCurrencyId,
    description: input.description,
    idempotencyKey: input.idempotencyKey,
    issueInvoice: true,
    customer: ctx.customer,
    });
  } catch (err: any) {
    // The provider says it does not know whether the money moved. This must NOT
    // become FAILED: dunning retries failures, and retrying a charge that may
    // have landed takes the money twice.
    if (err?.outcomeUnknown === true) {
      await prisma.charge.update({
        where: { id: chargeId },
        data: { status: "UNKNOWN", failureCode: "outcome_unknown_reconciliation_required" },
      });
      await emitBillingEvent({
        type: "payment.failed",
        tenantId: input.tenantId,
        data: { invoiceId: invoice.id, reason: "outcome_unknown", amount: input.amount },
      });
      return {
        success: false,
        invoiceId: invoice.id,
        failureCode: "outcome_unknown_reconciliation_required",
        outcomeUnknown: true,
      };
    }

    // Refused on the way OUT, before anything was sent. The money cannot have
    // moved, so this is a definite failure and must be recorded as one.
    //
    // Leaving it PENDING was worse than it looks. The idempotency lookup treats
    // a PENDING row as a charge still in flight, so every retry of the same key
    // came back "outcome unknown" - a clean, fixable local error (a missing
    // client identifier, a currency mismatch) turned into a permanent "we do
    // not know whether we took your money", and the customer could never get
    // past it even once the underlying problem was fixed.
    if (err?.neverSent === true) {
      const failureCode = err.failureCode ?? "charge_refused_before_send";
      await prisma.charge.update({
        where: { id: chargeId },
        data: { status: "FAILED", failureCode },
      });
      await emitBillingEvent({
        type: "payment.failed",
        tenantId: input.tenantId,
        data: { invoiceId: invoice.id, reason: failureCode, amount: input.amount },
      });
      return { success: false, invoiceId: invoice.id, failureCode };
    }

    throw err;
  }

  if (result.requiresReconciliation) {
    // Accepted, but with no reference we could reconcile or refund it by.
    await prisma.charge.update({
      where: { id: chargeId },
      data: { status: "UNKNOWN", failureCode: result.failureCode ?? "charge_reference_missing" },
    });
    return {
      success: false,
      invoiceId: invoice.id,
      failureCode: result.failureCode,
      outcomeUnknown: true,
    };
  }

  await prisma.charge.update({
    where: { id: chargeId },
    data: {
      providerChargeRef: result.providerChargeRef,
      status: result.success ? "SUCCEEDED" : "FAILED",
      failureCode: result.failureCode,
    },
  });

  // The tax document, once the money has actually moved.
  //
  // cc/bill takes money and issues nothing - its documented parameters contain
  // no field that would produce a document - so this is a second call, and it
  // has to come after, because a receipt for a charge that then declined is a
  // document for money nobody paid.
  //
  // It can NEVER fail the charge. The money is gone; turning that into an error
  // would tell the caller to retry a completed payment. A document that did not
  // issue is a real problem, but it is a problem to chase with the charge
  // reference in hand, not one to solve by taking the money again.
  if (result.success && ctx.provider === "ICOUNT") {
    try {
      const recipient = await receiptRecipient(ctx.customer.email, input.tenantId);
      const doc = await createDocument({
        doctype: TAX_DOCTYPE,
        clientId: ctx.providerCustomerId,
        clientName: ctx.identity.billingName || recipient || "Customer",
        vatId: ctx.customer.vatId,
        email: recipient ?? undefined,
        address: ctx.identity.billingAddress ?? undefined,
        currencyId: quote.providerCurrencyId,
        description: input.description,
        net: taxed.net,
        vatPercent: taxed.percent,
        gross: taxed.gross,
        confirmationCode: result.providerChargeRef,
        cardType: ctx.card.brand ?? undefined,
        cardLast4: ctx.card.last4 ?? undefined,
        // The customer gets their receipt without having to come and find it.
        sendEmail: Boolean(recipient),
      });
      await prisma.charge.update({
        where: { id: chargeId },
        data: { documentRef: doc.docNumber, documentUrl: doc.docUrl },
      });

      // Then make sure it actually went out.
      //
      // `send_email` on the create is a request whose answer may say nothing,
      // and "we asked for it to be sent" is not the same fact as "it was sent".
      // So unless iCount explicitly confirmed delivery, the document is sent
      // again to a named address and the outcome recorded. A duplicate receipt
      // is a mild annoyance; a customer with no proof of payment is not.
      if (recipient && doc.docNumber && doc.emailSent !== true) {
        // Its own try/catch: the document exists by this point, so a failure
        // here must not be reported as one that never issued. The two are
        // chased differently - one needs resending, the other reissuing.
        const sendResult = await emailDocument({
          doctype: TAX_DOCTYPE,
          docNumber: doc.docNumber,
          to: recipient,
        }).catch((e: any) => ({ sent: false as const, reason: e?.message ?? "send_failed", raw: null }));
        if (sendResult.sent === false) {
          // Issued but undelivered. Not a charge failure - the money moved and
          // the document exists - but a real problem, and it must be visible
          // rather than inferred later from a customer complaint.
          await emitBillingEvent({
            type: "payment.document_failed",
            tenantId: input.tenantId,
            data: {
              invoiceId: invoice.id,
              chargeRef: result.providerChargeRef,
              documentRef: doc.docNumber,
              reason: `document_email_not_sent: ${sendResult.reason ?? "unknown"}`,
              recipient,
            },
          });
        }
      } else if (!recipient) {
        await emitBillingEvent({
          type: "payment.document_failed",
          tenantId: input.tenantId,
          data: {
            invoiceId: invoice.id,
            chargeRef: result.providerChargeRef,
            documentRef: doc.docNumber,
            reason: "no_receipt_recipient",
          },
        });
      }
    } catch (err: any) {
      console.error(
        `[billing] charge ${chargeId} succeeded but its tax document did not issue:`,
        err?.message ?? err,
      );
      await emitBillingEvent({
        type: "payment.document_failed",
        tenantId: input.tenantId,
        data: {
          invoiceId: invoice.id,
          chargeRef: result.providerChargeRef,
          reason: err?.message ?? "document_failed",
        },
      });
    }
  }

  if (result.success) {
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: "PAID", issuedAt: new Date(), paidAt: new Date(), providerInvoiceRef: result.providerInvoiceRef, providerPdfUrl: result.providerPdfUrl },
    });
    await emitBillingEvent({ type: "invoice.paid", tenantId: input.tenantId, data: { invoiceId: invoice.id, amount: input.amount, providerInvoiceRef: result.providerInvoiceRef } });
    return { success: true, invoiceId: invoice.id };
  }

  await prisma.invoice.update({ where: { id: invoice.id }, data: { status: "FAILED" } });
  await emitBillingEvent({ type: "payment.failed", tenantId: input.tenantId, data: { invoiceId: invoice.id, reason: result.failureCode, amount: input.amount } });
  return { success: false, invoiceId: invoice.id, failureCode: result.failureCode };
}

/**
 * Map an invoice type to a quote purpose.
 *
 * Kept explicit rather than casting the string through: the two vocabularies
 * are allowed to diverge, and a silent cast would break quietly if they did.
 */
function quotePurposeFor(type: string): QuotePurpose {
  switch (type) {
    case "SUBSCRIPTION": return "RENEWAL";
    case "CREDIT_PURCHASE": return "CREDIT_PACKAGE";
    case "AUTO_PURCHASE": return "AUTO_TOPUP";
    default: return "CREDIT_PACKAGE";
  }
}
