/**
 * "Powered by GOTCHA" on the customer-facing widgets (W8, 2026-10-14): on for
 * every workspace, on every widget (the site chat, the Shopify storefront
 * chat, the WhatsApp kind).
 *
 * Enforced in three places so no path can turn it off:
 * - every config normaliser stores and reads it as on, whatever was stored
 *   before (old rows that said off are served on with no backfill)
 * - the public configs are built from those normalisers
 * - the settings writers refuse an explicit off with 403 POWERED_BY_LOCKED,
 *   so a client is told instead of seeing "off" saved and "on" served
 *
 * A future plan entitlement (white label) unlocks it here and nowhere else.
 */
export const POWERED_BY_LOCKED = true;

export const POWERED_BY_LOCKED_CODE = "POWERED_BY_LOCKED" as const;

/** The stored or requested value as it takes effect. */
export function effectivePoweredBy(raw: unknown, fallback = true): boolean {
  if (POWERED_BY_LOCKED) return true;
  return typeof raw === "boolean" ? raw : fallback;
}

/** True when a settings patch asks to turn it off while it is locked. */
export function asksToHidePoweredBy(appearance: unknown): boolean {
  return POWERED_BY_LOCKED && !!appearance && typeof appearance === "object" && (appearance as Record<string, unknown>).showPoweredBy === false;
}
