/**
 * Replacing a workspace's Shopify store (App Review 132211, 2026-11-22).
 *
 * A workspace holds one Shopify store. When a person confirms "Replace <old> with <new>", the old store
 * is retired COMPLETELY before the new one is attached, so nothing of it is left to answer for the new:
 *   1. the app is uninstalled from the OLD store at Shopify, with the OLD store's own token (only while
 *      it is still connected; an uninstalled store is gone at Shopify already);
 *   2. the uninstall's own steps, scoped to THIS workspace's row: billing disconnects the old
 *      connection and cancels its Shopify subscription, revokes the Shopify-funded entitlements and
 *      spends the grandfather grant; the integration row is DISCONNECTED with its credentials cleared;
 *      the Shopify tool assignments are removed; the old store's chat is switched off;
 *   3. the old store's chat channel and installation are released from the workspace.
 * Then the caller attaches the new store, whose access comes only from its own Shopify Billing outcome.
 *
 * The NEW store is never touched here. Core, conversations, other integrations and subscription
 * history are kept.
 */
import { requestShopifySelfUninstall, type SelfUninstallOutcome } from "./connectors/shopify-self-uninstall.service";
import { releaseReplacedStoreChat } from "./shopify-chat-install.service";
import { notifyShopifyUninstalled } from "./shopify-billing-bridge.service";
import { completeShopifyUninstall } from "../routes/shopify-webhooks";
import { revokeCustomAppEntitlements } from "./shopify-custom-app-billing.service";

export interface RetiredStore {
  shopDomain: string;
  /** null when the old store was already uninstalled (nothing asked of Shopify). */
  shopify: SelfUninstallOutcome | null;
  outcome: string;
}

export async function retireReplacedStore(input: {
  tenantId: string;
  shopDomain: string;
  /** The old store is still CONNECTED: ask Shopify to uninstall the app from it. */
  connected: boolean;
}): Promise<RetiredStore> {
  const { tenantId, shopDomain } = input;
  let shopify: SelfUninstallOutcome | null = null;
  if (input.connected) {
    // Read the old token while it is still on the row (step 2 clears it). A refusal (the token was
    // already revoked, the store is gone) does not stop the retirement: our side is cleaned either way.
    shopify = await requestShopifySelfUninstall(tenantId).catch((err: any) => {
      console.warn(`[shopify-replace] tenant=${tenantId} uninstall at Shopify failed:`, err?.message);
      return { ok: false, reason: "shopify_refused" } as SelfUninstallOutcome;
    });
    const done = await completeShopifyUninstall({ shopDomain, body: {}, replacedBy: { tenantId } });
    await releaseReplacedStoreChat({ tenantId, shopDomain }).catch(() => ({ released: false }));
    console.log(`[shopify-replace] tenant=${tenantId} retired ${shopDomain}: shopify=${shopify.ok ? "uninstalled" : (shopify as any).reason} ${done.outcome}`);
    return { shopDomain, shopify, outcome: done.outcome };
  }
  // Uninstalled before (DISCONNECTED): its own webhook already did step 2's Shopify-side work. What is
  // left: billing spends the grandfather grant (a new store must not inherit it), and its chat leftovers.
  await notifyShopifyUninstalled({ shopDomain, replaced: true, tenantId });
  // A per-merchant custom app's grant (2026-11-22) has no Shopify subscription behind it: revoked here too.
  await revokeCustomAppEntitlements(tenantId).catch(() => 0);
  await releaseReplacedStoreChat({ tenantId, shopDomain }).catch(() => ({ released: false }));
  console.log(`[shopify-replace] tenant=${tenantId} cleared the leftovers of uninstalled ${shopDomain}`);
  return { shopDomain, shopify: null, outcome: "leftovers_cleared" };
}
