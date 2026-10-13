/**
 * The Billing page as Shopify App Review will read it.
 *
 * The finding on submission 132211 was that several GOTCHA plans were visible
 * with no way to tell whether Shopify functionality was being sold outside
 * Shopify Billing. The fix is not fewer plans - Core is a real standalone
 * product - it is that both subscriptions are present and each says who bills
 * it. These tests assert exactly that, and that Core did not regress.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { getTranslation, t as translate, type Locale } from "@/i18n";

let locale: Locale = "en";

// One STABLE t per locale. The page memoises its loader on `t`, so handing it a
// fresh function on every render makes the effect re-run forever and the page
// never leaves its loading skeleton.
const T: Record<Locale, (k: string, v?: Record<string, string>) => string> = {
  en: (k, v) => translate(getTranslation("en"), k, v),
  he: (k, v) => translate(getTranslation("he"), k, v),
};
const I18N: Record<Locale, any> = {
  en: { locale: "en", dir: "ltr", t: T.en },
  he: { locale: "he", dir: "rtl", t: T.he },
};

vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ token: "tok" }) }));
vi.mock("@/context/I18nContext", () => ({ useI18n: () => I18N[locale] }));
vi.mock("@/context/PermissionsContext", () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/components/billing/ReceiptDetailsForm", () => ({
  __esModule: true,
  default: () => null,
  useBillingIdentity: () => ({ identity: null, reload: vi.fn() }),
}));

const shopifyState = vi.fn();

// The Core billing helpers live in api-billing; only the Shopify snapshot and
// the plan handoff come from api. Mocking the wrong one leaves the page making
// real network calls and quietly rendering "no subscription".
vi.mock("@/lib/api-billing", () => ({
  getSubscription: vi.fn(async () => ({
    subscription: {
      planKey: "ai_workforce", planName: "AI Workforce", status: "ACTIVE",
      currentPeriodEnd: "2026-12-01T00:00:00.000Z", cancelAtPeriodEnd: false,
      includedAiUnits: 1000, currency: "USD", amount: 99,
    },
  })),
  getPlans: vi.fn(async () => ({
    plans: [
      { key: "foundation", name: "Foundation", monthlyPrice: 49, currency: "USD", includedAiUnits: 0, features: [] },
      { key: "ai_workforce", name: "AI Workforce", monthlyPrice: 99, currency: "USD", includedAiUnits: 1000, features: [] },
      { key: "ai_voice", name: "AI Voice", monthlyPrice: 199, currency: "USD", includedAiUnits: 2000, features: [] },
    ],
  })),
  getInvoices: vi.fn(async () => ({ invoices: [] })),
  getPaymentMethods: vi.fn(async () => ({ paymentMethods: [] })),
  getCurrentPricing: vi.fn(async () => ({ subscription: null, evaluationPrompt: null })),
  cancelSubscription: vi.fn(),
  resumeSubscription: vi.fn(),
  settledCharge: () => null,
}));

vi.mock("@/lib/api", () => ({
  getShopifyBillingState: (...a: unknown[]) => shopifyState(...a),
  startShopifyPlanSelection: vi.fn(),
}));

import BillingSettingsPage from "../page";

const EN = getTranslation("en").settings.billing as any;
const HE = getTranslation("he").settings.billing as any;

function snap(over: any = {}) {
  return {
    core: { subscriptionStatus: "ACTIVE", planKey: "ai_workforce", billingSource: "GOTCHA_EXTERNAL" },
    installation: { status: "CONNECTED", shopDomain: "demo.myshopify.com", externalShopId: "1", connectionId: "c1", installedAt: null, uninstalledAt: null },
    shopify: {
      state: "ACTIVE", reason: "ok", planKey: "connector", planHandle: "connector",
      providerSubscriptionId: "s1", rawStatus: "ACTIVE", trialEndsAt: null, currentPeriodEnd: null,
      cancelAtPeriodEnd: false, declined: false, unknownPlanHandle: null, lastVerifiedAt: null,
      ...(over.shopify ?? {}),
    },
    grandfathered: null,
    entitlements: ["shopify_catalog_sync"],
    planSelectionUrl: "https://admin.shopify.com/store/demo/charges/x",
    availablePlanCount: 1,
    requiresPlanSelection: false,
    grantsAccess: "grantsAccess" in over ? over.grantsAccess : true,
  };
}

beforeEach(() => {
  locale = "en";
  shopifyState.mockReset();
  shopifyState.mockResolvedValue({ data: snap() });
});

describe("GOTCHA Core stays a first-class product", () => {
  it("still shows the Core subscription and its plan", async () => {
    render(<BillingSettingsPage />);
    expect(await screen.findByTestId("core-identity")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(EN.current)).toBeTruthy());
    expect(screen.getByText(/AI Workforce|ai_workforce/)).toBeTruthy();
  });

  it("says Core is billed by GOTCHA", async () => {
    render(<BillingSettingsPage />);
    expect(await screen.findByTestId("core-billed-by")).toHaveTextContent(EN.core.billedBy);
  });

  it("describes Core as standalone and lists non-Shopify capabilities", async () => {
    render(<BillingSettingsPage />);
    await screen.findByTestId("core-identity");
    expect(screen.getByText(EN.core.lede)).toBeTruthy();
    expect(EN.core.includes).toMatch(/WooCommerce/);
    expect(EN.core.includes).toMatch(/Inbox/i);
  });

  it("states plainly that Core does not include Shopify", async () => {
    render(<BillingSettingsPage />);
    const el = await screen.findByTestId("core-not-shopify");
    expect(el).toHaveTextContent(EN.core.notShopify);
    expect(EN.core.notShopify).toMatch(/does not include connection to Shopify/i);
  });

  it("keeps the Core upgrade on GOTCHA's own billing flow", async () => {
    const { container } = render(<BillingSettingsPage />);
    await screen.findByTestId("core-identity");
    const links = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    // The Core upgrade path is a GOTCHA route, not a Shopify URL.
    expect(links).toContain("/settings/billing/plan");
    expect(links.some((h) => h?.includes("shopify.com"))).toBe(false);
  });
});

describe("both subscriptions are visible together", () => {
  it("renders Core and the Shopify Connector on the same page", async () => {
    render(<BillingSettingsPage />);
    expect(await screen.findByTestId("core-identity")).toBeTruthy();
    expect(await screen.findByTestId("shopify-connector-section")).toBeTruthy();
  });

  it("Core active and Connector active coexist", async () => {
    render(<BillingSettingsPage />);
    expect(await screen.findByTestId("connector-state-active")).toBeTruthy();
    expect(screen.getByTestId("core-billed-by")).toHaveTextContent(EN.core.billedBy);
    expect(screen.getByTestId("connector-billed-by")).toHaveTextContent(EN.shopifyConnector.billedBy);
  });

  it("a cancelled Connector leaves the Core section intact", async () => {
    shopifyState.mockResolvedValue({ data: snap({ shopify: { state: "CANCELLED" }, grantsAccess: false }) });
    render(<BillingSettingsPage />);
    expect(await screen.findByTestId("connector-state-cancelled")).toBeTruthy();
    expect(screen.getByTestId("core-identity")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(EN.current)).toBeTruthy());
    expect(screen.getByText(/AI Workforce|ai_workforce/)).toBeTruthy();
  });

  it("the two 'billed by' statements name different companies", async () => {
    render(<BillingSettingsPage />);
    await screen.findByTestId("connector-billed-by");
    const core = screen.getByTestId("core-billed-by").textContent ?? "";
    const conn = screen.getByTestId("connector-billed-by").textContent ?? "";
    expect(core).not.toBe(conn);
    expect(core).toMatch(/GOTCHA/);
    expect(conn).toMatch(/Shopify/);
  });
});

describe("the page survives Shopify being unavailable", () => {
  it("renders Core normally when the Shopify state cannot be read", async () => {
    shopifyState.mockRejectedValue(new Error("down"));
    render(<BillingSettingsPage />);
    expect(await screen.findByTestId("core-identity")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(EN.current)).toBeTruthy());
    expect(screen.getByText(/AI Workforce|ai_workforce/)).toBeTruthy();
  });

  /**
   * The Connector section must NEVER vanish from Billing.
   *
   * If it did, a reviewer would see only externally billed GOTCHA plans, and
   * the honest conclusion from that page alone is that Shopify functionality
   * is included in them. That is exactly the 1.2.1 finding, recreated by an
   * empty state.
   */
  it("keeps the Connector section visible when Shopify billing is UNRESOLVED", async () => {
    shopifyState.mockResolvedValue({ data: snap({ shopify: { state: "UNRESOLVED" }, grantsAccess: false }) });
    render(<BillingSettingsPage />);

    // Core is intact...
    expect(await screen.findByTestId("core-identity")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(EN.current)).toBeTruthy());
    expect(screen.getByText(/AI Workforce|ai_workforce/)).toBeTruthy();

    // ...and the Connector is still explained as separate and Shopify-billed.
    expect(await screen.findByTestId("shopify-connector-section")).toBeTruthy();
    expect(screen.getByTestId("connector-state-notActive")).toBeTruthy();
    expect(screen.getByTestId("connector-billed-by")).toHaveTextContent(EN.shopifyConnector.billedBy);

    // ...and the page still says Core excludes Shopify.
    expect(screen.getByTestId("core-not-shopify")).toHaveTextContent(EN.core.notShopify);

    // Not an error: nothing was installed, nothing went wrong.
    expect(screen.queryByText(EN.shopifyConnector.loadFailed)).toBeNull();
  });
});

describe("Hebrew", () => {
  it("renders both sections in Hebrew", async () => {
    locale = "he";
    render(<BillingSettingsPage />);
    expect(await screen.findByTestId("core-billed-by")).toHaveTextContent(HE.core.billedBy);
    expect(await screen.findByTestId("connector-billed-by")).toHaveTextContent(HE.shopifyConnector.billedBy);
    expect(HE.core.notShopify).toMatch(/[֐-׿]/);
  });
});
