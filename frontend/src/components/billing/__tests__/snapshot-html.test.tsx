/**
 * NOT an assertion suite. This renders each Connector state to a standalone
 * HTML file so the states can be screenshotted for the App Review submission.
 * Kept beside the tests because it must render the REAL component with the REAL
 * translations - a mockup drawn by hand would prove nothing about what ships.
 */
import { describe, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { writeFileSync, mkdirSync } from "node:fs";
import { getTranslation, t as translate, type Locale } from "@/i18n";

const OUT = process.env.SHOT_DIR || "";
const getState = vi.fn();

let locale: Locale = "en";
const T: Record<Locale, any> = {
  en: { locale: "en", dir: "ltr", t: (k: string, v?: any) => translate(getTranslation("en"), k, v) },
  he: { locale: "he", dir: "rtl", t: (k: string, v?: any) => translate(getTranslation("he"), k, v) },
};
vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ token: "tok" }) }));
vi.mock("@/context/I18nContext", () => ({ useI18n: () => T[locale] }));
vi.mock("@/lib/api", () => ({
  getShopifyBillingState: (...a: unknown[]) => getState(...a),
  startShopifyPlanSelection: vi.fn(),
}));

import ShopifyConnectorSection from "../ShopifyConnectorSection";

function snap(over: any = {}) {
  return {
    core: { subscriptionStatus: "ACTIVE", planKey: "ai_workforce", billingSource: "GOTCHA_EXTERNAL" },
    installation: { status: "CONNECTED", shopDomain: "gotcha-review.myshopify.com", externalShopId: "1", connectionId: "c1", installedAt: null, uninstalledAt: null },
    shopify: {
      state: "ACTIVE", reason: "ok", planKey: "connector", planHandle: "connector",
      providerSubscriptionId: "s1", rawStatus: "ACTIVE", trialEndsAt: null, currentPeriodEnd: null,
      cancelAtPeriodEnd: false, declined: false, unknownPlanHandle: null, lastVerifiedAt: null,
      ...(over.shopify ?? {}),
    },
    grandfathered: over.grandfathered ?? null,
    entitlements: over.entitlements ?? ["shopify_catalog_sync", "shopify_order_read"],
    planSelectionUrl: "https://admin.shopify.com/store/gotcha-review/charges/connector/pricing_plans",
    availablePlanCount: 1,
    requiresPlanSelection: false,
    grantsAccess: "grantsAccess" in over ? over.grantsAccess : true,
  };
}

/** The Core identity card, copied from the Billing page so the pair can be shot together. */
function coreCard(loc: Locale) {
  const tt = T[loc].t;
  return `
  <div class="mb-6 rounded-xl border border-gray-200 bg-white p-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="text-sm font-semibold text-gray-900">${tt("settings.billing.core.heading")}</h2>
      <span class="rounded-full border border-gray-300 bg-gray-50 px-2.5 py-1 text-xs font-medium text-gray-700">${tt("settings.billing.core.billedBy")}</span>
    </div>
    <p class="mt-2 text-sm text-gray-700">${tt("settings.billing.core.lede")}</p>
    <p class="mt-1 text-sm text-gray-600">${tt("settings.billing.core.includes")}</p>
    <p class="mt-2 text-sm font-medium text-gray-900">${tt("settings.billing.core.notShopify")}</p>
  </div>
  <div class="mb-6 rounded-xl border border-gray-200 bg-white p-4">
    <h2 class="text-xs font-semibold uppercase tracking-wider text-gray-400">${tt("settings.billing.current")}</h2>
    <div class="mt-2 flex items-center gap-2">
      <span class="text-lg font-semibold text-gray-900">AI Workforce</span>
      <span class="rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">Active</span>
    </div>
    <p class="mt-1 text-sm text-gray-500">$99 / month &middot; ${tt("settings.billing.core.billedBy")}</p>
  </div>`;
}

async function shoot(name: string, loc: Locale, over: any) {
  // Each state gets a fresh document: successive renders otherwise stack in the
  // same body and the test-id lookup finds several.
  cleanup();
  locale = loc;
  getState.mockReset();
  getState.mockResolvedValue({ data: snap(over) });
  const { container, findByTestId } = render(<ShopifyConnectorSection />);
  await findByTestId("connector-billed-by");
  await new Promise((r) => setTimeout(r, 30));
  const dir = loc === "he" ? "rtl" : "ltr";
  const html = `<!doctype html><html lang="${loc}" dir="${dir}"><head><meta charset="utf-8">
<link rel="stylesheet" href="./app.css">
<style>body{background:#f8fafc}</style></head>
<body><div class="mx-auto max-w-3xl p-6">
<h1 class="text-2xl font-bold text-gray-900">${T[loc].t("settings.billing.title")}</h1>
<p class="mt-1 mb-6 text-sm text-gray-500">${T[loc].t("settings.billing.subtitle")}</p>
${coreCard(loc)}
<div class="rounded-xl border border-gray-200 bg-white p-4">${container.innerHTML}</div>
</div></body></html>`;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/${name}.html`, html);
}

// Opt-in: only runs when a destination is given, so an ordinary test run does
// not write files anywhere.
describe.skipIf(!process.env.SHOT_DIR)("render states for screenshots", () => {
  it("writes every state", async () => {
    await shoot("1-core-active-connector-active", "en", { shopify: { state: "ACTIVE" }, grantsAccess: true });
    await shoot("2-core-active-connector-required", "en", { shopify: { state: "PLAN_SELECTION_REQUIRED" }, grantsAccess: false });
    await shoot("3-core-active-connector-cancelled", "en", { shopify: { state: "CANCELLED" }, grantsAccess: false });
    await shoot("4-unknown-plan", "en", { shopify: { state: "UNKNOWN_PLAN", unknownPlanHandle: "connector-monthly-v2" }, grantsAccess: true });
    await shoot("5-grandfathered", "en", {
      shopify: { state: "NOT_REQUIRED_GRANDFATHERED" },
      grandfathered: { grantedAt: "2026-05-01T00:00:00.000Z", source: "PRE_PUBLICATION", reason: "existing customer", paidSince: null },
      grantsAccess: true,
    });
    await shoot("6-hebrew-rtl-connector-required", "he", { shopify: { state: "PLAN_SELECTION_REQUIRED" }, grantsAccess: false });
    // Added after review feedback: the Connector must never vanish from
    // Billing, and UNKNOWN_PLAN must follow grantsAccess rather than its name.
    await shoot("7-unresolved-still-visible", "en", { shopify: { state: "UNRESOLVED" }, grantsAccess: false });
    await shoot("8-unknown-plan-access-off", "en", { shopify: { state: "UNKNOWN_PLAN", unknownPlanHandle: "connector-monthly-v2" }, grantsAccess: false });
    await shoot("9-unknown-plan-access-preserved", "en", { shopify: { state: "UNKNOWN_PLAN", unknownPlanHandle: "connector-monthly-v2" }, grantsAccess: true });
  });
});
