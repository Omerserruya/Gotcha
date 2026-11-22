import { z } from 'zod';

/**
 * Connecting a Shopify store that was installed from Shopify (App Review
 * 132211, 2.1.1) - every wire the web side reads, in one file.
 *
 * Backend's contract, final: ca1156f9 (2026-11-22).
 *
 *   GET  /api/connectors/shopify/install/pending (the pending cookie, forwarded)
 *        → { data: { shopDomain, recovered, expiresAt,
 *                    current: { shopDomain, status CONNECTED|DISCONNECTED } | null,
 *                    action: attach | replace | blocked,
 *                    blockedReason?: core_plan_required | held_by_other_workspace } }
 *        404 pending_install_not_found (cookie cleared) · 401/403: nothing shown.
 *   POST /api/connectors/shopify/install/claim { replace?: true }
 *        → { data: { shopDomain, reconnected, flow, billingState, planSelectionUrl } }
 *        409 another_store_connected { currentShopDomain, incomingShopDomain }
 *        · 409 shop_connected_to_another_workspace · 402 core_plan_required
 *        · 404 pending_install_not_found · 409 pending_install_already_used
 *        · 503 billing_link_failed (nothing changed; the approval is kept)
 *   POST /api/connectors/shopify/install/pending/dismiss → 204, touches no store
 */

export const PENDING_ACTIONS = ['attach', 'replace', 'blocked'] as const;
export type PendingAction = (typeof PENDING_ACTIONS)[number];
export const BLOCKED_REASONS = ['core_plan_required', 'held_by_other_workspace'] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];

const currentSchema = z
  .looseObject({ shopDomain: z.string().min(1), status: z.string().catch('CONNECTED') })
  .nullable()
  .catch(null)
  .default(null);

/** One pending install, read whole: no shop, or an action we do not know, is no prompt. */
export const pendingInstallSchema = z.looseObject({
  shopDomain: z.string().min(1),
  expiresAt: z.string().nullable().catch(null).default(null),
  current: currentSchema,
  action: z.enum(PENDING_ACTIONS),
  blockedReason: z.enum(BLOCKED_REASONS).nullable().catch(null).default(null),
});
export type PendingInstall = z.infer<typeof pendingInstallSchema>;

/** Only an https page of Shopify's is somewhere to send a browser. */
const shopifyPage = z
  .string()
  .url()
  .refine((url) => new URL(url).protocol === 'https:')
  .nullable()
  .catch(null);

/** The claim's answer: Shopify's plan page when one is owed, else nowhere to go. */
export const claimAnswerSchema = z
  .looseObject({
    data: z
      .looseObject({
        planSelectionUrl: shopifyPage.optional().default(null),
        billingState: z.string().nullable().catch(null).default(null),
      })
      .catch({ planSelectionUrl: null, billingState: null }),
  })
  .transform((a) => ({
    planSelectionUrl: a.data.planSelectionUrl ?? null,
    // A private (custom) store with entitlement "manual": connected, the Shopify features wait (beaecd42).
    awaitingGrant: a.data.billingState === 'CUSTOM_APP_AWAITING_GRANT',
  }));

/** What a claim came to, as the screen tells it. */
export type ClaimRefusal =
  | 'replace_required'
  | 'custom_app_for_another_workspace'
  | 'core_plan_required'
  | 'held_by_other_workspace'
  | 'expired'
  | 'billing_unavailable'
  | 'forbidden'
  | 'failed';

/**
 * A refusal by its code, then its status. Backend's codes (ca1156f9) and
 * the draft's names both read the same way.
 */
export function claimRefusalOf(status: number | undefined, code: string | undefined): ClaimRefusal {
  if (code === 'replace_required' || code === 'another_store_connected') return 'replace_required';
  // A private app made for a different workspace's request (beaecd42).
  if (code === 'custom_app_for_another_workspace') return 'custom_app_for_another_workspace';
  if (code === 'core_plan_required' || status === 402) return 'core_plan_required';
  if (code === 'held_by_other_workspace' || code === 'shop_connected_to_another_workspace') {
    return 'held_by_other_workspace';
  }
  if (
    code === 'expired' ||
    code === 'pending_install_already_used' ||
    status === 410 ||
    status === 404
  ) {
    return 'expired';
  }
  if (code === 'billing_link_failed' || code === 'billing_unavailable' || status === 503) {
    return 'billing_unavailable';
  }
  if (status === 403) return 'forbidden';
  return 'failed';
}
