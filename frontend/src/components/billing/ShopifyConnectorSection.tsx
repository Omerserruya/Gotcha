"use client";

/**
 * The Shopify Connector, presented on the Billing page beside GOTCHA Core.
 *
 * WHY THIS EXISTS
 * ---------------
 * Shopify App Review paused submission 132211 under requirement 1.2.1 because
 * the Billing page showed several GOTCHA plans and the reviewer could not tell
 * whether any Shopify functionality was being sold outside Shopify Billing.
 * The page said nothing about Shopify at all - the only Shopify billing strip
 * lived on a different screen - so the reviewer had no way to reach the right
 * conclusion from what was in front of them.
 *
 * The fix is not to hide GOTCHA's own plans. They are a legitimate standalone
 * product. The fix is to show BOTH subscriptions, say who bills each, and make
 * it obvious they coexist rather than compete.
 *
 * WHAT THIS COMPONENT REFUSES TO DO
 * ---------------------------------
 * It does not decide whether Shopify is active: `presentConnector` copies the
 * server's verdict. It does not construct a Shopify URL - the server returns
 * one, because a URL built here could point at a plan page for a store this
 * workspace does not own. And it does not print a price: the plan catalog says
 * in its own header that Shopify owns the price, and a number hardcoded here
 * would eventually disagree with the one the merchant is actually charged.
 */

import { useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import {
  getShopifyBillingState,
  startShopifyPlanSelection,
  type ShopifyBillingSnapshot,
} from "@/lib/api";
import {
  presentConnector,
  CONNECTOR_CAPABILITY_KEYS,
  type ConnectorTone,
} from "@/lib/shopify-connector-state";

const TONE_CLASS: Record<ConnectorTone, string> = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-900",
  warn: "border-amber-200 bg-amber-50 text-amber-900",
  info: "border-sky-200 bg-sky-50 text-sky-900",
  neutral: "border-gray-200 bg-gray-50 text-gray-800",
};

export default function ShopifyConnectorSection() {
  const { token } = useAuth();
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<ShopifyBillingSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let alive = true;
    getShopifyBillingState(token)
      .then((r) => alive && setSnapshot(r.data))
      .catch(() => alive && setFailed(true))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [token]);

  // alwaysShow: the Billing page keeps this section even when Shopify billing
  // is UNRESOLVED. If it vanished, the only thing left on the page would be
  // externally billed GOTCHA plans, and the honest conclusion from that page
  // alone is that Shopify comes with them - which is the 1.2.1 finding.
  const p = presentConnector(snapshot, { alwaysShow: true });

  async function goToShopify() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const { data } = await startShopifyPlanSelection(token);
      // A full navigation, not a new tab: the merchant returns to
      // /integrations/shopify/billing/complete in this same browser context.
      window.location.href = data.url;
    } catch {
      setError(t("settings.billing.shopifyConnector.loadFailed"));
      setBusy(false);
    }
  }

  /** Re-read OUR state. Used when Shopify's answer could not be resolved. */
  async function recheck() {
    if (!token) return;
    setBusy(true);
    setError(null);
    setFailed(false);
    try {
      const r = await getShopifyBillingState(token);
      setSnapshot(r.data);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const ACTION_LABEL: Record<string, string> = {
    choosePlan: t("settings.billing.shopifyConnector.choosePlan"),
    manage: t("settings.billing.shopifyConnector.manageInShopify"),
    retry: t("settings.billing.shopifyConnector.retry"),
  };

  return (
    <section className="border-t border-gray-100 pt-6 mt-6" data-testid="shopify-connector-section">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
          {t("settings.billing.shopifyConnector.heading")}
        </h2>
        {/* The single most important sentence on this page for a reviewer. */}
        <span
          className="rounded-full border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700"
          data-testid="connector-billed-by"
        >
          {t("settings.billing.shopifyConnector.billedBy")}
        </span>
      </div>

      <p className="text-sm text-gray-700">{t("settings.billing.shopifyConnector.lede")}</p>
      <p className="mt-1 text-sm text-gray-500">
        {t("settings.billing.shopifyConnector.separateNote")}
      </p>

      {/* Fixed min-height so the async state cannot shift the layout under the
          reader as the snapshot arrives. */}
      <div className="mt-4 min-h-[92px]">
        {loading ? (
          <div
            className="h-[92px] animate-pulse rounded-xl bg-gray-100"
            aria-label={t("settings.billing.shopifyConnector.loading")}
            role="status"
          />
        ) : failed || !p ? (
          <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700">
            {t("settings.billing.shopifyConnector.loadFailed")}
          </div>
        ) : (
          <div className={`rounded-xl border px-4 py-3 ${TONE_CLASS[p.tone]}`} data-testid={`connector-state-${p.key}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold">{t(p.titleKey, p.vars)}</p>
                <p className="mt-1 text-sm opacity-90">{t(p.bodyKey, p.vars)}</p>

                {/* Whether Shopify data is actually on. Server verdict, not OAuth. */}
                <p className="mt-2 text-xs font-medium" data-testid="connector-access">
                  {p.grantsAccess
                    ? t("settings.billing.shopifyConnector.accessOn")
                    : `${t("settings.billing.shopifyConnector.accessOff")} ${t("settings.billing.shopifyConnector.coreUnaffected")}`}
                </p>

                {p.support && (
                  <p className="mt-2 text-xs opacity-80" data-testid="connector-support">
                    {t("settings.billing.shopifyConnector.supportLine")}
                  </p>
                )}

                {error && <p className="mt-2 text-sm font-medium text-red-700">{error}</p>}
              </div>

              {p.action !== "none" && (
                <button
                  type="button"
                  onClick={p.action === "retry" ? recheck : goToShopify}
                  disabled={busy}
                  data-testid="connector-cta"
                  data-action={p.action}
                  className="shrink-0 rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-60"
                >
                  {busy ? t("settings.billing.shopifyConnector.loading") : ACTION_LABEL[p.action]}
                </button>
              )}
            </div>

            {snapshot?.installation?.shopDomain && (
              <p className="mt-2 text-xs opacity-70">{snapshot.installation.shopDomain}</p>
            )}
          </div>
        )}
      </div>

      <div className="mt-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">
          {t("settings.billing.shopifyConnector.capabilitiesTitle")}
        </p>
        <ul className="mt-2 space-y-1 text-sm text-gray-700">
          {CONNECTOR_CAPABILITY_KEYS.map((k) => (
            <li key={k} className="flex gap-2">
              <span aria-hidden="true" className="text-gray-400">
                &bull;
              </span>
              <span>{t(k)}</span>
            </li>
          ))}
        </ul>
        {/* No price here on purpose: Shopify owns it. See the header comment. */}
        <p className="mt-3 text-xs text-gray-500">
          {t("settings.billing.shopifyConnector.pricingNote")}
        </p>
      </div>
    </section>
  );
}
