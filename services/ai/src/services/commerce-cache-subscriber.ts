/**
 * Invalidate the commerce-context cache when a Shopify order changes, so the
 * human panel and AI snapshot never serve stale order state after a webhook
 * (spec §9). The publisher is the inbound Shopify order webhook
 * (orders/updated | orders/cancelled | refunds/create); this service reacts.
 *
 * NOTE (limitation): Shopify order-webhook INGESTION is a separate integration
 * concern - once the webhook service publishes `shopify.order.changed`, this
 * subscriber invalidates automatically. Until then, invalidation is driven by
 * the post-action path in commerce-actions.service.
 */
import { subscribeToEvents, type ServiceEvent } from "@chatcenter/shared";
import { invalidateCommerceCache } from "./commerce-context.service";

const COMMERCE_ORDER_EVENTS = new Set([
  "shopify.order.changed",
  "shopify.order.updated",
  "shopify.order.cancelled",
  "shopify.order.refunded",
]);

/** Pure handler (exported for tests): invalidate on a relevant order event. */
export function handleCommerceCacheEvent(event: ServiceEvent): number {
  if (!event?.tenantId || !COMMERCE_ORDER_EVENTS.has(event.event)) return 0;
  const conversationId = event.data?.conversationId as string | undefined;
  return invalidateCommerceCache({ tenantId: event.tenantId, conversationId });
}

export function startCommerceCacheSubscriber() {
  const sub = subscribeToEvents((event) => {
    try {
      const n = handleCommerceCacheEvent(event);
      if (n > 0) console.log(`[commerce-cache] invalidated ${n} entr${n === 1 ? "y" : "ies"} on ${event.event} tenant=${event.tenantId}`);
    } catch (err: any) {
      console.warn("[commerce-cache] invalidation handler error:", err?.message);
    }
  });
  console.log("[commerce-cache] subscriber started (shopify.order.* → cache invalidation)");
  return sub;
}
