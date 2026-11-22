/**
 * Meta telling us that our app lost a business's WhatsApp account (2026-11-22).
 *
 * It arrives as a WABA-level `account_update` change:
 *
 *   { field: "account_update",
 *     value: { event: "PARTNER_REMOVED",
 *              waba_info: { waba_id, owner_business_id },
 *              disconnection_info: { reason, initiated_by } } }
 *
 * The business's WABA is `value.waba_info.waba_id`. `entry.id` on this change
 * is a different id (read from a real delivery), so it is never used here.
 *
 * Two events mean it: PARTNER_REMOVED (the business removed us as a partner,
 * or disconnected the account) and PARTNER_APP_UNINSTALLED. Every other
 * account_update event (a ban, a review, PARTNER_ADDED, ...) is not this.
 */
export const WHATSAPP_ACCESS_REMOVAL_EVENTS = ["PARTNER_REMOVED", "PARTNER_APP_UNINSTALLED"] as const;
export type WhatsAppAccessRemovalEvent = (typeof WHATSAPP_ACCESS_REMOVAL_EVENTS)[number];

export interface WhatsAppAccessRemoval {
  wabaId: string;
  event: WhatsAppAccessRemovalEvent;
}

/** The removal an account_update value carries, or null when it carries none. */
export function whatsappAccessRemoval(value: unknown): WhatsAppAccessRemoval | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { event?: unknown; waba_info?: { waba_id?: unknown } | null };
  const event = WHATSAPP_ACCESS_REMOVAL_EVENTS.find((e) => e === v.event);
  if (!event) return null;
  const raw = v.waba_info?.waba_id;
  const wabaId = typeof raw === "string" || typeof raw === "number" ? String(raw).trim() : "";
  return wabaId ? { wabaId, event } : null;
}
