/**
 * The receipt email, sent by us.
 *
 * It used to come from iCount. That is a fine way to satisfy the tax authority
 * and a poor way to talk to a customer: the message arrives from an address
 * they have no relationship with, in a layout we do not control, at the one
 * moment they are most certain they just paid us. So the legal document is
 * still ISSUED by iCount - that part is not ours to own - and the email that
 * carries it is ours, from no-reply@, in the product's own language.
 *
 * Delivery goes onto the notifications email queue rather than through a direct
 * SMTP call: notifications already owns the transport, the retries and the send
 * log, and duplicating that here would give us a second, worse copy of it.
 *
 * This never throws. The caller has already taken the money and issued the
 * document by the time it runs, and it reports failure by returning false so
 * the caller can fall back to having iCount send instead.
 */
import { Queue } from "bullmq";
import {
  renderBrandEmail,
  emailAmount,
  emailKeyValueTable,
  emailParagraph,
  escapeHtml,
  NOTIFICATIONS_EMAIL_QUEUE_NAME,
  type EmailJobData,
} from "@chatcenter/shared";
import { CURRENCY_ID_ILS, CURRENCY_ID_USD } from "../providers/icount-client";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

let _queue: Queue | null = null;
function emailQueue(): Queue {
  if (!_queue) _queue = new Queue(NOTIFICATIONS_EMAIL_QUEUE_NAME, { connection: { url: REDIS_URL } });
  return _queue;
}

/** Test seam, mirroring the one in lib/events.ts. */
export function __setEmailQueueForTests(q: Queue | null): void {
  _queue = q;
}

export function currencyCodeFor(currencyId: number): string {
  if (currencyId === CURRENCY_ID_ILS) return "ILS";
  if (currencyId === CURRENCY_ID_USD) return "USD";
  return "";
}

/** Israeli billing address gets the Hebrew receipt. Everyone else gets English. */
function localeFor(billingCountry: string | null): "he" | "en" {
  return (billingCountry ?? "").trim().toUpperCase() === "IL" ? "he" : "en";
}

function money(amount: string, code: string): string {
  return code ? `${amount} ${code}` : amount;
}

export interface ReceiptEmailInput {
  to: string;
  tenantId: string;
  billingName: string | null;
  billingCountry: string | null;
  description: string;
  net: string;
  vatPercent: number;
  gross: string;
  currencyId: number;
  docNumber: string | null;
  docUrl: string | null;
  issuedAt?: Date;
}

/** Returns true only when the job was accepted by the queue. */
export async function sendReceiptEmail(input: ReceiptEmailInput): Promise<boolean> {
  try {
    const he = localeFor(input.billingCountry) === "he";
    const locale = he ? "he" : "en";
    const code = currencyCodeFor(input.currencyId);
    const total = money(input.gross, code);
    const when = (input.issuedAt ?? new Date()).toLocaleDateString(he ? "he-IL" : "en-GB", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });

    const vatAmount = (Number(input.gross) - Number(input.net)).toFixed(2);
    const rows: Array<[string, string]> = [
      [he ? "לפני מע״מ" : "Subtotal", money(input.net, code)],
      [
        he ? `מע״מ (${input.vatPercent}%)` : `VAT (${input.vatPercent}%)`,
        Number.isFinite(Number(vatAmount)) ? money(vatAmount, code) : money("0.00", code),
      ],
      [he ? "סה״כ שחויב" : "Total charged", total],
    ];

    const details: string[] = [
      emailAmount(he ? "חויב" : "Charged", escapeHtml(total), escapeHtml(input.description), locale),
      emailKeyValueTable(
        [he ? "פירוט" : "Breakdown", ""],
        rows.map(([k, v]) => [escapeHtml(k), escapeHtml(v)] as [string, string]),
        locale,
      ),
    ];

    if (input.docNumber) {
      details.push(
        emailParagraph(
          he
            ? `מספר החשבונית: <strong>${escapeHtml(input.docNumber)}</strong> · הופקה ב-${escapeHtml(when)}`
            : `Invoice number: <strong>${escapeHtml(input.docNumber)}</strong> · Issued ${escapeHtml(when)}`,
          locale,
        ),
      );
    }

    const html = renderBrandEmail({
      title: he ? "קבלה מ-GOTCHA" : "Your GOTCHA receipt",
      preheader: he ? `שולם ${total}. החשבונית מצורפת כאן.` : `Paid ${total}. Your invoice is here.`,
      eyebrow: he ? "התשלום התקבל" : "Payment confirmed",
      headline: he ? "הכל מסודר." : "You're all set.",
      subhead: he
        ? "קיבלנו את התשלום. אלה הפרטים לתיעוד שלכם."
        : "We received your payment. Here are the details for your records.",
      bodyHtml: details.join(""),
      // The document itself lives at the provider. We link to it rather than
      // mirror it, so what the customer opens is the legal original.
      cta: input.docUrl ? { label: he ? "צפייה בחשבונית" : "View invoice", url: input.docUrl } : undefined,
      footerNote: he
        ? "קיבלתם את המייל הזה כי זו כתובת החיוב של החשבון."
        : "You received this because this is the billing address on the account.",
      locale,
    });

    const text = [
      he ? "התשלום התקבל." : "Payment confirmed.",
      "",
      `${he ? "סה״כ שחויב" : "Total charged"}: ${total}`,
      input.description,
      input.docNumber ? `${he ? "מספר החשבונית" : "Invoice number"}: ${input.docNumber}` : "",
      input.docUrl ? `${he ? "צפייה בחשבונית" : "View invoice"}: ${input.docUrl}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const job: EmailJobData = {
      tenantId: input.tenantId,
      // The billing address is not necessarily a platform user, and the rate
      // limit is keyed by user. Empty here, and bypassed below.
      userId: "",
      to: input.to,
      eventType: "payment.receipt",
      eventId: input.docNumber ? `receipt:${input.docNumber}` : `receipt:${input.tenantId}:${Date.now()}`,
      priority: "high",
      subject: he
        ? `קבלה מ-GOTCHA · ${total}`
        : `Your GOTCHA receipt · ${total}`,
      body: text,
      link: input.docUrl ?? undefined,
      html,
      bypassRateLimit: true,
    };

    await emailQueue().add("send-email", job, {
      removeOnComplete: 1000,
      removeOnFail: 100,
      attempts: 5,
      backoff: { type: "exponential", delay: 2_000 },
    });
    return true;
  } catch (err: any) {
    console.warn("[billing] receipt email could not be queued:", err?.message ?? err);
    return false;
  }
}
