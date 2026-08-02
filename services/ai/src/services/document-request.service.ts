/**
 * "תשלחו לי חשבונית" - and the six other things that sentence can mean.
 *
 * Scenario 28 failed as `shopify_406`, a provider status code shown to a
 * customer who had asked for an invoice. The status code was the visible bug.
 * The real one is that "invoice" was treated as a single capability when it is
 * at least three:
 *
 *   - an ORDER CONFIRMATION, which Shopify can re-send
 *   - a PAYMENT RECEIPT, which for a paid Shopify order is the same email
 *   - a TAX INVOICE, which is an accounting document with legal weight and
 *     which Shopify does not produce
 *
 * Collapsing them means the third is answered by attempting the first, and a
 * customer who needs a document for their accountant is handed an order
 * summary and told it is an invoice. That is a worse failure than a 406,
 * because it looks like success.
 *
 * No invoicing provider exists in this deployment's integration catalog at all
 * - not iCount, not anything else - so a tax invoice is honestly unavailable
 * and is reported as unavailable, with real alternatives, and without a
 * provider error code.
 */

export type DocumentType =
  | "order_confirmation"
  | "payment_receipt"
  | "order_status_link"
  | "shipping_confirmation"
  | "refund_confirmation"
  | "invoice"
  | "tax_invoice"
  | "credit_note";

/**
 * Ordered most-specific first. "חשבונית מס" must not be matched by the plain
 * "חשבונית" rule, because the whole point is that they are different documents
 * with different providers.
 */
const PATTERNS: Array<{ type: DocumentType; re: RegExp }> = [
  { type: "tax_invoice", re: /(חשבונית\s*מס|חשבונית\s*מס\/קבלה|tax\s*invoice|vat\s*invoice)/i },
  { type: "credit_note", re: /(חשבונית\s*זיכוי|תעודת\s*זיכוי|credit\s*note|credit\s*memo)/i },
  { type: "refund_confirmation", re: /(אישור\s*(על\s*)?(ה)?החזר|אסמכתא\s*(ל)?החזר|refund\s*(confirmation|receipt|proof))/i },
  { type: "shipping_confirmation", re: /(אישור\s*משלוח|אישור\s*שילוח|shipping\s*confirmation|dispatch\s*(note|confirmation))/i },
  { type: "payment_receipt", re: /(קבלה|אסמכתא\s*(ל)?תשלום|אישור\s*תשלום|receipt|proof\s*of\s*payment)/i },
  { type: "order_confirmation", re: /(אישור\s*הזמנה|אישור\s*(ה)?רכישה|order\s*confirmation|confirmation\s*email)/i },
  { type: "order_status_link", re: /(סטטוס\s*הזמנה|לינק\s*למעקב|קישור\s*למעקב|order\s*status\s*(link|page)|tracking\s*link)/i },
  { type: "invoice", re: /(חשבונית|invoice)/i },
];

export function detectDocumentRequest(text: string | null | undefined): DocumentType | null {
  const t = String(text ?? "");
  for (const { type, re } of PATTERNS) {
    if (re.test(t)) return type;
  }
  return null;
}

export type DeliveryChannel = "email" | "whatsapp" | "none";

export interface DocumentCapability {
  documentType: DocumentType;
  /** Can anything connected actually produce this document? */
  available: boolean;
  /** Which system would produce it. */
  source: "shopify" | "invoicing_provider" | "gotcha" | "none";
  /** How it can be delivered, if at all. */
  channels: DeliveryChannel[];
  /** Why not, in words a customer can hear. */
  reason: string;
  /** Real things that CAN be offered instead. */
  alternatives: string[];
}

export interface DocumentContext {
  /** Shopify is connected and the order tools work. */
  shopifyConnected: boolean;
  /** An accounting/invoicing integration is connected AND can locate documents. */
  invoicingProvider: string | null;
  /** The conversation can send a file or a link to the customer. */
  canSendWhatsAppMedia: boolean;
  /** A verified email is on the customer record. */
  hasCustomerEmail: boolean;
}

/**
 * A tax invoice or a credit note is an accounting document. Shopify order data
 * can be formatted to look like one, which is precisely why it must not be:
 * a document that says "tax invoice" and was not issued by an invoicing system
 * is not a tax invoice, it is a forgery with a friendly tone.
 */
const ACCOUNTING_DOCUMENTS: DocumentType[] = ["tax_invoice", "credit_note"];

export function resolveDocumentCapability(
  documentType: DocumentType,
  ctx: DocumentContext,
): DocumentCapability {
  const alternatives: string[] = [];
  if (ctx.shopifyConnected) {
    alternatives.push("a summary of the order read straight from the shop's records");
    alternatives.push("the carrier's own tracking link, when there is one");
  }
  alternatives.push("a handover to a person who can send the document");

  if (ACCOUNTING_DOCUMENTS.includes(documentType)) {
    if (!ctx.invoicingProvider) {
      return {
        documentType,
        available: false,
        source: "none",
        channels: [],
        reason:
          "No accounting or invoicing system is connected to this shop, so a tax document cannot be issued or located from here.",
        alternatives,
      };
    }
    return {
      documentType,
      available: true,
      source: "invoicing_provider",
      channels: deliveryChannels(ctx),
      reason: `Documents are issued by ${ctx.invoicingProvider}.`,
      alternatives,
    };
  }

  if (!ctx.shopifyConnected) {
    return {
      documentType,
      available: false,
      source: "none",
      channels: [],
      reason: "The shop's order system is not reachable from this conversation.",
      alternatives,
    };
  }

  // The order-status link is a special case and the interesting one. Shopify's
  // `order_status_url` carries `authenticate?key=`, which is a bearer
  // credential for that customer's order page - pasting it into a chat hands it
  // to whoever reads the transcript later. So the link is never sent, and the
  // status is given in words instead.
  if (documentType === "order_status_link") {
    return {
      documentType,
      available: false,
      source: "shopify",
      channels: [],
      reason:
        "The shop's order-status link is a private, pre-authenticated URL, so it is not something to send in a chat.",
      alternatives: [
        "the current status of the order, said plainly",
        ...(ctx.shopifyConnected ? ["the carrier's own tracking link, when there is one"] : []),
      ],
    };
  }

  const channels = deliveryChannels(ctx);
  if (!channels.length) {
    return {
      documentType,
      available: false,
      source: "shopify",
      channels: [],
      reason: "There is no verified address or channel on this conversation to send it to.",
      alternatives,
    };
  }

  return {
    documentType,
    available: true,
    source: "shopify",
    channels,
    reason: "Shopify can send this from the order.",
    alternatives,
  };
}

function deliveryChannels(ctx: DocumentContext): DeliveryChannel[] {
  const out: DeliveryChannel[] = [];
  if (ctx.hasCustomerEmail) out.push("email");
  if (ctx.canSendWhatsAppMedia) out.push("whatsapp");
  return out;
}

/**
 * What the model may attempt and what it may say.
 *
 * The destination rule is the one worth being strict about. A financial
 * document goes to the address ALREADY on the account - never to one typed in
 * chat. `customer-access-guard.ts` enforces that for `send_invoice` by refusing
 * a `to` override outright; this says the same thing to the model so it stops
 * asking the customer where to send it as though that were a normal question.
 */
export function buildDocumentDirective(cap: DocumentCapability): string {
  const lines = [`The customer is asking for a document: ${describe(cap.documentType)}.`];

  if (!cap.available) {
    lines.push(
      `This is NOT available: ${cap.reason}`,
      `Say that plainly, in the customer's language, without any provider name, status code or error text.`,
      `Then offer what is real: ${cap.alternatives.join("; ")}.`,
      `Do NOT send anything and do NOT say a document was sent, attached or emailed.`,
      `Do NOT present an order summary as an invoice or a receipt - a document is what it was issued as, not what we call it.`,
    );
    if (ACCOUNTING_DOCUMENTS.includes(cap.documentType)) {
      lines.push(
        `In particular, do NOT produce anything that looks like a tax document. A tax invoice not issued by an invoicing system is not one.`,
      );
    }
    return lines.join("\n");
  }

  lines.push(
    `This CAN be sent, from ${cap.source === "shopify" ? "the shop's own order records" : cap.source}.`,
    `It goes ONLY to the address already stored on the account. If the customer wants it somewhere else, that is a profile change, not a send - handle it as one.`,
    `Never ask them to give you an address to send it to and never accept one from the conversation.`,
    `Available channels: ${cap.channels.join(", ")}.`,
    `Say it was sent ONLY after the send tool returns success, and say which channel it went to.`,
    `If the send fails, say it did not go through and offer the alternatives - do NOT show the provider's error or status code.`,
    `Never include the shop's order-status link: it is pre-authenticated and belongs to the customer alone.`,
  );
  return lines.join("\n");
}

function describe(t: DocumentType): string {
  switch (t) {
    case "tax_invoice": return "a tax invoice";
    case "credit_note": return "a credit note";
    case "payment_receipt": return "a payment receipt";
    case "order_confirmation": return "an order confirmation";
    case "shipping_confirmation": return "a shipping confirmation";
    case "refund_confirmation": return "a refund confirmation";
    case "order_status_link": return "an order-status link";
    case "invoice": return "an invoice";
  }
}
