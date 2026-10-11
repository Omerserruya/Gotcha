/**
 * How a contact is named on screen: its name, or a handle the business knows
 * them by - never an opaque platform id.
 *
 * Instagram and Messenger ids (IGSID, PSID) and a web chat's session token mean
 * nothing to a person; the Customers list showed "1031990639501705" for an
 * Instagram customer (2026-10-11). On WhatsApp, voice and email the external
 * id IS the phone or the address, so it is a fair fallback there.
 * The inbound path writes an Instagram customer's name, or "@username", into
 * displayName, so the handle arrives through the first branch.
 */
const OPAQUE_ID_CHANNELS: Record<string, string> = {
  INSTAGRAM: "Instagram customer",
  MESSENGER: "Messenger customer",
  WEBCHAT: "Website visitor",
  SHOPIFY_LIVE_CHAT: "Store chat visitor",
};

export function contactLabel(c: {
  displayName?: string | null;
  phone?: string | null;
  email?: string | null;
  externalId?: string | null;
  channel?: string | null;
}): string {
  const named = c.displayName?.trim() || c.phone?.trim() || c.email?.trim();
  if (named) return named;
  const generic = c.channel ? OPAQUE_ID_CHANNELS[String(c.channel)] : undefined;
  if (generic) return generic;
  return c.externalId?.trim() || "Customer";
}
