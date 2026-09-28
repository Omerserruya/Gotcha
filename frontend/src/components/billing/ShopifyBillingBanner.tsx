"use client";

/**
 * The Shopify Connector state, said plainly on the Business Systems screen.
 *
 * WHY THIS IS A SEPARATE STRIP FROM THE CONNECTION CARD
 * ----------------------------------------------------
 * Installation and payment are two independent facts, and merging them into
 * one badge is how a merchant ends up reading "Not connected" when their store
 * is connected and simply unpaid - then disconnecting and reinstalling to fix a
 * problem that reinstalling cannot fix.
 *
 * So the integration card keeps saying whether the store is connected, and this
 * strip says whether it is paid for. When there is nothing to say - no store,
 * or Shopify billing switched off for this deployment - it renders nothing at
 * all rather than an empty box.
 *
 * ONE INTERPRETATION, SHARED WITH BILLING
 * ---------------------------------------
 * The state-to-words mapping lives in `lib/shopify-connector-state` and is the
 * SAME one the Billing page uses. It used to live here as a local function with
 * hardcoded English, which meant the Billing page could not reuse it and the
 * two screens were free to drift into contradicting each other - precisely the
 * inconsistency an App Store reviewer looks for. It also made the strip
 * English-only on a product that ships Hebrew.
 *
 * NOTHING HERE DECIDES ANYTHING. Every state, and the plan URL, comes from the
 * server, which computed it from a verified read. The component cannot construct
 * a Shopify link, and deliberately has no code path that would let it: a URL
 * built here could point at a plan page for a store this workspace does not own.
 */

import { useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  getShopifyBillingState,
  startShopifyPlanSelection,
  type ShopifyBillingSnapshot,
} from "@/lib/api";
import { presentConnector, type ConnectorTone } from "@/lib/shopify-connector-state";

const TONE_CLASS: Record<ConnectorTone, string> = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-900",
  warn: "border-amber-200 bg-amber-50 text-amber-900",
  info: "border-sky-200 bg-sky-50 text-sky-900",
  neutral: "border-gray-200 bg-gray-50 text-gray-800",
};

export default function ShopifyBillingBanner() {
  const { token } = useAuth();
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<ShopifyBillingSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    getShopifyBillingState(token)
      .then((r) => setSnapshot(r.data))
      // Silent. This is a supplementary strip on a screen that must render
      // without it; a failed read here is not worth an error banner over the
      // whole page.
      .catch(() => setSnapshot(null));
  }, [token]);

  const p = presentConnector(snapshot);

  // Nothing to say: no store, or Shopify billing off for this deployment. The
  // "no store connected" case is left to the connection card, which already
  // says it and says it better.
  if (!p || p.key === "notConnected") return null;

  async function choosePlan() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const { data } = await startShopifyPlanSelection(token);
      // A full navigation, not a new tab: the merchant comes back to
      // /integrations/shopify/billing/complete and the return has to land in
      // this same browser context.
      window.location.href = data.url;
    } catch {
      setError(t("settings.billing.shopifyConnector.loadFailed"));
      setBusy(false);
    }
  }

  const manage = p.key === "active" || p.key === "trialing" || p.key === "grandfathered";

  return (
    <div className={`rounded-xl border px-4 py-3 ${TONE_CLASS[p.tone]}`} data-testid={`connector-state-${p.key}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{t(p.titleKey, p.vars)}</p>
          <p className="mt-1 text-sm opacity-90">{t(p.bodyKey, p.vars)}</p>
          {/* Same sentence as the Billing page, from the same key. */}
          <p className="mt-2 text-xs font-medium opacity-80">
            {t("settings.billing.shopifyConnector.billedBy")}
          </p>
          {error && <p className="mt-2 text-sm font-medium text-red-700">{error}</p>}
        </div>

        {p.action && (
          <button
            type="button"
            onClick={choosePlan}
            disabled={busy}
            data-testid="connector-cta"
            className="shrink-0 rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-60"
          >
            {busy
              ? t("settings.billing.shopifyConnector.loading")
              : manage
                ? t("settings.billing.shopifyConnector.manageInShopify")
                : t("settings.billing.shopifyConnector.choosePlan")}
          </button>
        )}
      </div>

      {/* Deliberately the merchant's own store, not an id. The numeric shop id
          is what the system keys on and means nothing to the person reading. */}
      {snapshot?.installation?.shopDomain && (
        <p className="mt-2 text-xs opacity-70">{snapshot.installation.shopDomain}</p>
      )}
    </div>
  );
}
