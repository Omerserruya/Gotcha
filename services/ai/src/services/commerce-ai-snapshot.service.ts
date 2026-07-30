/**
 * Typed customer-commerce snapshot for the AI employee (spec §7).
 *
 * The SAME verified projection the human panel uses, stripped of anything the
 * model must not see or leak: no admin URLs, no refundable-maximum, no internal
 * segmentation / lifetime-value labels. Injected only when Shopify is the
 * tenant's elected Source of Truth AND the conversation's customer is
 * verified-linked - a typed phone/email/order number never qualifies.
 *
 * It is injected as a STRUCTURED block through the prompt context layer, never
 * as raw Shopify JSON, and it carries explicit behavioral guardrails.
 */

import type { AICommerceSnapshot, CommerceContext } from "@chatcenter/shared";
import { buildCommerceContextResponse } from "./commerce-context.service";
import { getSourceOfTruth } from "./connectors/source-of-truth";

const AI_RECENT_LIMIT = 5;

/** Strip a full CommerceContext to the model-safe snapshot. */
function toSnapshot(ctx: CommerceContext): AICommerceSnapshot {
  return {
    provider: "shopify",
    customer: {
      verified: true,
      customerId: ctx.customer.customerId,
      orderCount: ctx.summary.orderCount,
      totalSpent: ctx.summary.shopCurrencyTotal, // shop-currency aggregate only
      lastOrderAt: ctx.summary.lastOrderAt,
    },
    recentOrders: ctx.recentOrders.map((o) => ({
      orderId: o.orderId,
      orderNumber: o.orderNumber,
      createdAt: o.createdAt,
      total: o.total,
      financialStatus: o.financial.key,
      fulfillmentStatus: o.fulfillment.key,
      cancelled: o.cancelled,
      refundedAmount: o.refundedAmount,
      items: o.items.map((it) => ({ title: it.title, quantity: it.quantity })),
    })),
  };
}

/**
 * Build the AI commerce snapshot for a conversation, or null when it doesn't
 * apply (Shopify not the SoT, customer not verified-linked, no orders, or any
 * error). Never throws into the bot turn.
 */
export async function buildAICommerceSnapshot(opts: {
  tenantId: string;
  conversationId: string;
}): Promise<AICommerceSnapshot | null> {
  try {
    // Only when Shopify is the elected Source of Truth for this tenant.
    const sot = await getSourceOfTruth(opts.tenantId);
    if (!sot || sot.vendor !== "shopify") return null;

    const res = await buildCommerceContextResponse({
      tenantId: opts.tenantId,
      conversationId: opts.conversationId,
      // The AI employee never gets action capabilities - read projection only.
      perms: { canRead: true, canOpen: false, canCancel: false, canRefund: false, canTag: false, canNote: false, canNotify: false },
      recentLimit: AI_RECENT_LIMIT,
    });
    if (res.state !== "ok") return null;
    return toSnapshot(res.data);
  } catch {
    return null;
  }
}

/**
 * Format the snapshot as a compact, guard-railed prompt block. The guardrails
 * are structural (not just advisory): the model is given machine facts + a
 * hard list of what it must not do with them.
 */
export function formatCommerceSnapshotForPrompt(
  snapshot: AICommerceSnapshot,
  locale: "he" | "en" = "en",
): string {
  const he = locale === "he";
  const lines: string[] = [];
  lines.push(he ? "# הקשר רכש מאומת (Shopify)" : "# Verified commerce context (Shopify)");
  const spent = snapshot.customer.totalSpent
    ? `${snapshot.customer.totalSpent.amount} ${snapshot.customer.totalSpent.currency}`
    : "n/a";
  lines.push(
    he
      ? `לקוח מאומת. הזמנות: ${snapshot.customer.orderCount}. סה"כ רכש: ${spent}. הזמנה אחרונה: ${snapshot.customer.lastOrderAt ?? "לא ידוע"}.`
      : `Verified customer. Orders: ${snapshot.customer.orderCount}. Total spent: ${spent}. Last order: ${snapshot.customer.lastOrderAt ?? "unknown"}.`,
  );
  for (const o of snapshot.recentOrders) {
    const status = o.cancelled ? "cancelled" : o.financialStatus;
    const item = o.items[0]?.title ?? "";
    const extra = o.items.length > 1 ? ` +${o.items.length - 1}` : "";
    lines.push(`- ${o.orderNumber} · ${o.total.amount} ${o.total.currency} · ${status} · ${o.fulfillmentStatus} · ${item}${extra}`);
  }
  lines.push(
    he
      ? "כללי שימוש: אל תחשוף דירוג/ערך-לקוח פנימי או סכומי הוצאה כטיפול מועדף אלא אם הוגדר במפורש. אל תמציא הטבות נאמנות. אל תתייחס לטלפון/אימייל/מספר הזמנה שהוקלדו בצ'אט כזהות מאומתת. השתמש בהקשר כדי להימנע משאלות מיותרות ולתת שירות מדויק."
      : "Usage rules: never reveal internal segmentation/lifetime-value or frame spend as special treatment unless explicitly configured; never invent loyalty benefits; never treat a typed phone/email/order number as verified identity; use this context to avoid asking for details already known and to give more accurate service.",
  );
  return lines.join("\n");
}
