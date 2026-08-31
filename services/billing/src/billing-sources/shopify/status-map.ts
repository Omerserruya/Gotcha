/**
 * Shopify's subscription vocabulary, mapped into ours without losing theirs.
 *
 * `AppSubscriptionStatus` (Admin API 2026-07) is:
 *
 *   PENDING    awaiting the merchant's approval
 *   ACTIVE     approved and being billed
 *   DECLINED   the merchant said no. TERMINAL.
 *   EXPIRED    not approved within TWO DAYS of creation. TERMINAL.
 *   FROZEN     on hold for non-payment; re-activates when payments resume
 *   CANCELLED  cancelled by the app, by uninstall, or superseded. TERMINAL.
 *
 * Two of these are easy to map wrongly, and both mistakes are expensive.
 *
 * FROZEN IS NOT SUSPENDED. Shopify recovers a frozen subscription BY ITSELF
 * once the merchant's payments resume - nothing is required from us and no
 * human has to act. Our own SUSPENDED means the opposite: dunning is exhausted
 * and somebody has to intervene. Treating FROZEN as SUSPENDED would put a
 * self-healing account into a queue for manual work, and - worse - would invite
 * destructive "clean up suspended accounts" behaviour against a merchant who is
 * about to come back on their own.
 *
 * EXPIRED IS NOT CANCELLED. It means the merchant was offered a plan and never
 * answered within Shopify's two-day window. That is the "abandoned plan
 * selection" case, and it is worth telling apart from a deliberate refusal
 * (DECLINED) and from an ended subscription (CANCELLED), because the right
 * follow-up differs for each.
 *
 * The raw string travels alongside the mapped value everywhere. Mapping is
 * lossy by construction, and the provider's own word is what a support
 * conversation and a reconciliation mismatch both actually need.
 */
import type { ProviderSubscriptionStatus } from "@prisma/client";

const MAP: Record<string, ProviderSubscriptionStatus> = {
  PENDING: "PENDING",
  ACTIVE: "ACTIVE",
  DECLINED: "DECLINED",
  EXPIRED: "EXPIRED",
  FROZEN: "FROZEN",
  CANCELLED: "CANCELLED",
  // Shopify's own deprecated spelling. Accepted so an older payload does not
  // fall through to REQUIRES_ACTION and look like a problem.
  ACCEPTED: "ACTIVE",
  CANCELED: "CANCELLED",
};

/**
 * Map a Shopify status. An unrecognised value becomes REQUIRES_ACTION.
 *
 * Deliberately NOT defaulted to CANCELLED or ACTIVE. A status we do not
 * recognise means Shopify has changed something and we do not know what is
 * true; defaulting to ACTIVE would serve a merchant who may not be paying, and
 * defaulting to CANCELLED would cut off one who is. REQUIRES_ACTION says the
 * honest thing and puts it in front of a human.
 */
export function mapShopifyStatus(raw: string | null | undefined): ProviderSubscriptionStatus {
  const key = String(raw ?? "").trim().toUpperCase();
  const mapped = MAP[key];
  if (!mapped) {
    if (key) {
      console.warn(
        `[shopify-billing] unrecognised AppSubscriptionStatus "${key}" - treating as REQUIRES_ACTION ` +
          `rather than guessing. Check https://shopify.dev/docs/api/admin-graphql for a new value.`,
      );
    }
    return "REQUIRES_ACTION";
  }
  return mapped;
}

/** Statuses from which Shopify will never move on its own. */
export function isTerminalShopifyStatus(status: ProviderSubscriptionStatus): boolean {
  return status === "DECLINED" || status === "EXPIRED" || status === "CANCELLED";
}

/**
 * Whether payment-gated Shopify entitlements may be active.
 *
 * FROZEN is deliberately EXCLUDED: the merchant is not currently paying, so the
 * paid capability stops. It is not terminal, though, so nothing is deleted and
 * access returns by itself when Shopify reactivates the charge.
 *
 * TRIALING counts as entitled - a trial is access the merchant was promised.
 */
export function grantsAccess(status: ProviderSubscriptionStatus): boolean {
  return status === "ACTIVE" || status === "TRIALING";
}
