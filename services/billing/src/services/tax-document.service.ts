/**
 * The tax document, and getting it to the customer.
 *
 * There are two charging paths in this service - `chargeFor` (renewals, plan
 * changes, credit purchases, auto top-ups) and `executeCharge` (the self-serve
 * checkout). They differ in how they claim and lease a charge, and they should:
 * those are genuinely different concurrency problems. What must NOT differ is
 * what the customer ends up holding. A first payment that produced no receipt
 * while every later one did is not a smaller version of the same bug, it is the
 * one payment a new customer is most likely to ask about.
 *
 * So the document lives here, once, and both call it.
 */
import { prisma } from "@chatcenter/shared";
import { createDocument, emailDocument } from "../providers/icount-client";
import { emitBillingEvent } from "../lib/events";
import { sendReceiptEmail } from "./receipt-email.service";

/**
 * חשבונית מס קבלה - the document that is both the tax invoice and the receipt.
 * Confirmed against the account's own doc/types, which lists it as "invrec".
 */
export const TAX_DOCTYPE = "invrec";

/** Who the document is made out to, and where they are liable. */
export interface ReceiptIdentity {
  billingName: string | null;
  billingCountry: string | null;
  billingAddress: string | null;
  billingEmail: string | null;
  vatId: string | null;
  providerCustomerId: string | null;
}

/**
 * The receipt identity for a billable entity.
 *
 * Reads only what was DECLARED. There is deliberately no fallback to the
 * tenant's name or country: the tenant name is a workspace label, not a legal
 * entity, and `Tenant.defaultCountryCode` is a phone-normalisation default.
 * A receipt carrying the wrong legal entity is worse than one nobody issued.
 */
export async function receiptIdentityForEntity(entityId: string): Promise<ReceiptIdentity | null> {
  const profile = await prisma.billingProfile.findUnique({ where: { billableEntityId: entityId } });
  if (!profile) return null;
  return {
    billingName: profile.billingName ?? null,
    billingCountry: profile.billingCountry ?? null,
    billingAddress: profile.billingAddress ?? null,
    billingEmail: profile.billingEmail ?? null,
    vatId: profile.vatId ?? null,
    providerCustomerId: profile.providerCustomerId ?? null,
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
export async function receiptRecipient(
  billingEmail: string | null | undefined,
  tenantId: string | null | undefined,
): Promise<string | null> {
  const declared = String(billingEmail ?? "").trim();
  if (declared) return declared;
  if (!tenantId) return null;

  const admin = await prisma.user.findFirst({
    where: { tenantId, role: "ADMIN", isActive: true },
    orderBy: { createdAt: "asc" },
    select: { email: true },
  });
  return admin?.email?.trim() || null;
}

export interface IssueTaxDocumentInput {
  tenantId: string;
  /** For the event trail, so a missing document is traceable to its payment. */
  invoiceId?: string | null;
  identity: ReceiptIdentity;
  description: string;
  /** The provider's currency id, from the frozen quote. Never defaulted. */
  currencyId: number;
  /** Ex-tax, as a decimal string. */
  net: string;
  /** Whole percent. 0 means exempt, stated as such on the document. */
  vatPercent: number;
  /** Inclusive of tax - what the card was actually charged. */
  gross: string;
  /** The charge this documents, so the two point at each other. */
  confirmationCode?: string;
  cardBrand?: string | null;
  cardLast4?: string | null;
}

export interface IssuedDocument {
  docNumber: string | null;
  docUrl: string | null;
}

/**
 * Issue the tax document for a charge that already happened, and make sure it
 * reaches the customer.
 *
 * NEVER throws. The money has already moved by the time this runs; turning a
 * document failure into an error would tell the caller to retry a completed
 * payment. A document that did not issue is a real problem, but it is one to
 * chase with the charge reference in hand, not one to solve by taking the
 * money again. Returns null when nothing was issued.
 *
 * The document is ISSUED by iCount and DELIVERED by us. `send_email` on
 * doc/create is off deliberately: two senders means two receipts, one of them
 * from an address the customer has no relationship with.
 *
 * The fallback to the provider covers the queue refusing the job, which is the
 * failure we can still see from here. It does NOT cover a later SMTP failure:
 * once the job is accepted, delivery belongs to the notifications worker, which
 * retries with backoff and records the outcome in NotificationLog. A receipt
 * that dies there is visible in that log, not here.
 */
export async function issueTaxDocument(input: IssueTaxDocumentInput): Promise<IssuedDocument | null> {
  const { identity } = input;
  try {
    const recipient = await receiptRecipient(identity.billingEmail, input.tenantId);

    const doc = await createDocument({
      doctype: TAX_DOCTYPE,
      clientId: identity.providerCustomerId ?? undefined,
      clientName: identity.billingName || recipient || "Customer",
      vatId: identity.vatId ?? undefined,
      email: recipient ?? undefined,
      address: identity.billingAddress ?? undefined,
      currencyId: input.currencyId,
      description: input.description,
      net: input.net,
      vatPercent: input.vatPercent,
      gross: input.gross,
      confirmationCode: input.confirmationCode,
      cardType: input.cardBrand ?? undefined,
      cardLast4: input.cardLast4 ?? undefined,
      // We send the receipt ourselves now, so iCount must NOT also send one.
      // Leaving this on is how the customer gets the same receipt twice, once
      // from us and once from an address they do not recognise.
      sendEmail: false,
    });

    if (!recipient) {
      await report(input, doc.docNumber, "no_receipt_recipient");
    } else if (doc.docNumber) {
      // Its own catch: the document exists by this point, so a failure here
      // must not be reported as one that never issued. The two are chased
      // differently - one needs resending, the other reissuing.
      const ours = await sendReceiptEmail({
        to: recipient,
        tenantId: input.tenantId,
        billingName: identity.billingName,
        billingCountry: identity.billingCountry,
        description: input.description,
        net: input.net,
        vatPercent: input.vatPercent,
        gross: input.gross,
        currencyId: input.currencyId,
        docNumber: doc.docNumber,
        docUrl: doc.docUrl ?? null,
      });

      if (!ours) {
        // The provider is the fallback, not the default. A customer with no
        // proof of payment is the one outcome worth an unbranded email.
        const sent = await emailDocument({
          doctype: TAX_DOCTYPE,
          docNumber: doc.docNumber,
          to: recipient,
        }).catch((e: any) => ({ sent: false as const, reason: e?.message ?? "send_failed", raw: null }));

        if (sent.sent === false) {
          await report(input, doc.docNumber, `document_email_not_sent: ${sent.reason ?? "unknown"}`, recipient);
        } else {
          await report(input, doc.docNumber, "receipt_email_fell_back_to_provider", recipient);
        }
      }
    }

    return { docNumber: doc.docNumber, docUrl: doc.docUrl };
  } catch (err: any) {
    console.error(
      `[billing] charge ${input.confirmationCode ?? "(no ref)"} succeeded but its tax document did not issue:`,
      err?.message ?? err,
    );
    await report(input, null, err?.message ?? "document_failed");
    return null;
  }
}

/** Make the problem visible. Emitting must never be what fails the caller. */
async function report(
  input: IssueTaxDocumentInput,
  documentRef: string | null,
  reason: string,
  recipient?: string,
): Promise<void> {
  await emitBillingEvent({
    type: "payment.document_failed",
    tenantId: input.tenantId,
    data: {
      invoiceId: input.invoiceId ?? null,
      chargeRef: input.confirmationCode ?? null,
      documentRef,
      reason,
      ...(recipient ? { recipient } : {}),
    },
  }).catch(() => {});
}
