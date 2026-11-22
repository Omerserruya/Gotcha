/**
 * Billing for a store on a per-merchant custom app (2026-11-22, Omer, path A): no Shopify Billing (a
 * custom distribution app has no Billing API). The four Shopify capabilities come from GOTCHA's own grant,
 * made by billing (source ADDON, reason "shopify_custom_app"), never by OAuth alone:
 *   - at connect, when the platform setting says "included";
 *   - by a person in the console, when it says "manual";
 *   - revoked on app/uninstalled, on Replace and on the console's revoke.
 * No card provider and no Shopify Billing call anywhere here.
 */
import { readPrivateAppsSettings, readCustomAppRecord, writeCustomAppRecord } from "@chatcenter/shared";
import { postToBilling } from "./shopify-billing-bridge.service";

export async function grantCustomAppEntitlements(tenantId: string, by: string): Promise<number> {
  const res = await postToBilling("/api/internal/billing/shopify/custom-app/grant", { tenantId, by });
  if (!res.ok) throw new Error(`billing custom-app grant returned ${res.status}`);
  return Number(((await res.json()) as any)?.data?.granted ?? 0);
}

export async function revokeCustomAppEntitlements(tenantId: string): Promise<number> {
  const res = await postToBilling("/api/internal/billing/shopify/custom-app/revoke", { tenantId });
  if (!res.ok) throw new Error(`billing custom-app revoke returned ${res.status}`);
  return Number(((await res.json()) as any)?.data?.revoked ?? 0);
}

/**
 * What a claim of a custom-app store gets instead of Shopify Billing's outcome: the grant now when the
 * platform says "included", nothing when "manual" (the store connects; its Shopify capabilities wait for a
 * person). Same shape as resolveShopifyBillingOutcome's answer; never a plan selection URL.
 */
export async function customAppBillingOutcome(tenantId: string): Promise<{ state: string; requiresPlanSelection: false; planSelectionUrl: null; grandfathered: false; connectionId: null }> {
  const settings = await readPrivateAppsSettings();
  if (settings.entitlement === "included") {
    await grantCustomAppEntitlements(tenantId, "connect");
    return { state: "CUSTOM_APP_GRANTED", requiresPlanSelection: false, planSelectionUrl: null, grandfathered: false, connectionId: null };
  }
  return { state: "CUSTOM_APP_AWAITING_GRANT", requiresPlanSelection: false, planSelectionUrl: null, grandfathered: false, connectionId: null };
}

/** The store is connected through its custom app: the record says installed (the console shows it). */
export async function markCustomAppInstalled(tenantId: string): Promise<void> {
  const r = await readCustomAppRecord(tenantId);
  if (!r || r.status === "revoked" || r.status === "installed") return;
  await writeCustomAppRecord(tenantId, { ...r, status: "installed", installedAt: new Date().toISOString() }, "system:shopify-custom-app");
}
