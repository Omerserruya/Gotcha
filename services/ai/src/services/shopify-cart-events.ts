/**
 * Shopify checkouts / orders → the shared CartEventJob (cart left behind).
 *
 * Pure: the webhook route verifies, resolves the tenant and enqueues. The
 * scopes: checkouts/create|update need `read_orders`, which the app holds
 * (https://shopify.dev/docs/api/admin-graphql/latest/enums/WebhookSubscriptionTopic).
 * Without Protected Customer Data approval Shopify redacts the email and
 * phone, and such a checkout simply has nobody to reach.
 */
import type { CartEventJob } from "@chatcenter/shared";

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const subscribed = (c: any): boolean | null =>
  c == null ? null : typeof c === "object" ? (c.state ? c.state === "subscribed" : null) : null;

/** A checkouts/create or checkouts/update payload. */
export function cartEventFromShopifyCheckout(tenantId: string, body: any): CartEventJob | null {
  const checkoutId = String(body?.token ?? body?.id ?? "").trim();
  if (!checkoutId) return null;
  const customer = body?.customer ?? {};
  const email = body?.email ?? customer?.email ?? null;
  const phone = body?.phone ?? body?.shipping_address?.phone ?? body?.billing_address?.phone ?? customer?.phone ?? null;
  const firstName = customer?.first_name ?? body?.billing_address?.first_name ?? body?.shipping_address?.first_name ?? null;
  const emailConsent =
    typeof body?.buyer_accepts_marketing === "boolean" ? body.buyer_accepts_marketing
      : subscribed(customer?.email_marketing_consent) ?? (typeof customer?.accepts_marketing === "boolean" ? customer.accepts_marketing : null);
  const smsConsent =
    typeof body?.buyer_accepts_sms === "boolean" ? body.buyer_accepts_sms : subscribed(customer?.sms_marketing_consent);
  return {
    tenantId,
    source: "shopify",
    checkoutId,
    completed: !!body?.completed_at,
    updatedAt: String(body?.updated_at ?? body?.created_at ?? new Date().toISOString()),
    customer: { email, phone, firstName },
    items: (Array.isArray(body?.line_items) ? body.line_items : []).map((l: any) => ({
      title: String(l?.title ?? l?.name ?? ""), quantity: Number(l?.quantity ?? 1) || 1, price: num(l?.price),
    })).filter((i: any) => i.title),
    total: num(body?.total_price ?? body?.subtotal_price),
    currency: body?.presentment_currency ?? body?.currency ?? null,
    cartUrl: body?.abandoned_checkout_url ?? null,
    marketingConsent: { email: emailConsent, sms: smsConsent },
  };
}

/** An orders/create payload: the checkout it came from is now bought. */
export function cartCompletionFromShopifyOrder(tenantId: string, body: any): CartEventJob | null {
  const checkoutId = String(body?.checkout_token ?? body?.cart_token ?? "").trim();
  if (!checkoutId) return null;
  return {
    tenantId, source: "shopify", checkoutId, completed: true,
    updatedAt: String(body?.created_at ?? new Date().toISOString()),
    customer: {}, items: [],
  };
}
