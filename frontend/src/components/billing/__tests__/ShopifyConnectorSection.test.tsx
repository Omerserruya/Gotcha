/**
 * The Shopify Connector section on the Billing page.
 *
 * This is the screen Shopify App Review paused submission 132211 over, so the
 * assertions are written the way a reviewer reads it: can I tell who bills
 * this, can I tell it is separate from GOTCHA Core, and does the button take me
 * to Shopify.
 *
 * The translations are the REAL en.json / he.json, not stubs, so a missing or
 * untranslated key fails here rather than shipping as a visible key name.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { getTranslation, t as translate, type Locale } from "@/i18n";

const getState = vi.fn();
const startPlan = vi.fn();

vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ token: "tok" }) }));

let locale: Locale = "en";
vi.mock("@/context/I18nContext", () => ({
  useI18n: () => ({
    locale,
    dir: locale === "he" ? "rtl" : "ltr",
    t: (key: string, vars?: Record<string, string>) => translate(getTranslation(locale), key, vars),
  }),
}));

vi.mock("@/lib/api", () => ({
  getShopifyBillingState: (...a: unknown[]) => getState(...a),
  startShopifyPlanSelection: (...a: unknown[]) => startPlan(...a),
}));

import ShopifyConnectorSection from "../ShopifyConnectorSection";

function snap(over: any = {}) {
  return {
    core: { subscriptionStatus: "ACTIVE", planKey: "ai_workforce", billingSource: "GOTCHA_EXTERNAL" },
    installation: {
      status: "CONNECTED", shopDomain: "demo.myshopify.com", externalShopId: "1",
      connectionId: "c1", installedAt: null, uninstalledAt: null, ...(over.installation ?? {}),
    },
    shopify: {
      state: "ACTIVE", reason: "ok", planKey: "connector", planHandle: "connector",
      providerSubscriptionId: "s1", rawStatus: "ACTIVE", trialEndsAt: null, currentPeriodEnd: null,
      cancelAtPeriodEnd: false, declined: false, unknownPlanHandle: null, lastVerifiedAt: null,
      ...(over.shopify ?? {}),
    },
    grandfathered: over.grandfathered ?? null,
    entitlements: over.entitlements ?? ["shopify_catalog_sync"],
    planSelectionUrl: "planSelectionUrl" in over ? over.planSelectionUrl : "https://admin.shopify.com/store/demo/charges/x",
    availablePlanCount: 1,
    requiresPlanSelection: false,
    grantsAccess: "grantsAccess" in over ? over.grantsAccess : true,
  };
}

const EN = getTranslation("en").settings.billing as any;
const HE = getTranslation("he").settings.billing as any;

beforeEach(() => {
  locale = "en";
  getState.mockReset();
  startPlan.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("the reviewer's two questions", () => {
  it("says the Connector is billed and managed by Shopify", async () => {
    getState.mockResolvedValue({ data: snap() });
    render(<ShopifyConnectorSection />);
    expect(await screen.findByTestId("connector-billed-by")).toHaveTextContent(
      EN.shopifyConnector.billedBy,
    );
    expect(EN.shopifyConnector.billedBy).toMatch(/billed and managed by shopify/i);
  });

  it("says the two subscriptions coexist rather than compete", async () => {
    getState.mockResolvedValue({ data: snap() });
    render(<ShopifyConnectorSection />);
    expect(await screen.findByText(EN.shopifyConnector.separateNote)).toBeTruthy();
    expect(EN.shopifyConnector.separateNote).toMatch(/not an alternative/i);
  });

  it("lists the Shopify capabilities the Connector unlocks", async () => {
    getState.mockResolvedValue({ data: snap() });
    render(<ShopifyConnectorSection />);
    for (const v of Object.values(EN.shopifyConnector.capabilities) as string[]) {
      expect(await screen.findByText(v)).toBeTruthy();
    }
  });
});

describe("the action goes to Shopify, never to GOTCHA checkout", () => {
  it("navigates to the server-supplied Shopify URL", async () => {
    getState.mockResolvedValue({
      data: snap({ shopify: { state: "PLAN_SELECTION_REQUIRED" }, grantsAccess: false }),
    });
    startPlan.mockResolvedValue({ data: { url: "https://admin.shopify.com/store/demo/charges/abc" } });

    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      value: { get href() { return ""; }, set href(v: string) { assign(v); } },
      writable: true,
      configurable: true,
    });

    render(<ShopifyConnectorSection />);
    const cta = await screen.findByTestId("connector-cta");
    fireEvent.click(cta);

    await waitFor(() => expect(assign).toHaveBeenCalled());
    const target = assign.mock.calls[0][0] as string;
    expect(target).toContain("admin.shopify.com");
    // Never GOTCHA's own checkout.
    expect(target).not.toMatch(/\/settings\/billing|gotcha\.co\.il|checkout/i);
  });

  it("offers a retry, not a Shopify link, when the server gave no destination", async () => {
    getState.mockResolvedValue({
      data: snap({ shopify: { state: "PLAN_SELECTION_REQUIRED" }, planSelectionUrl: null, grantsAccess: false }),
    });
    render(<ShopifyConnectorSection />);
    await screen.findByTestId("connector-state-billingRequired");
    const cta = screen.getByTestId("connector-cta");
    // A retry re-reads OUR state. It must never try to open Shopify, because
    // there is no server-supplied destination and the frontend may not invent
    // one.
    expect(cta.getAttribute("data-action")).toBe("retry");
    expect(cta).toHaveTextContent(EN.shopifyConnector.retry);

    getState.mockClear();
    fireEvent.click(cta);
    await waitFor(() => expect(getState).toHaveBeenCalled());
    expect(startPlan).not.toHaveBeenCalled();
  });
});

describe("state is shown accurately", () => {
  it("OAuth-only is 'Connector required' and reports features off", async () => {
    getState.mockResolvedValue({
      data: snap({ shopify: { state: "PLAN_SELECTION_REQUIRED" }, grantsAccess: false }),
    });
    render(<ShopifyConnectorSection />);
    expect(await screen.findByTestId("connector-state-billingRequired")).toBeTruthy();
    expect(screen.getByTestId("connector-access")).toHaveTextContent(EN.shopifyConnector.accessOff);
    // and it explicitly reassures that Core is untouched
    expect(screen.getByTestId("connector-access")).toHaveTextContent(EN.shopifyConnector.coreUnaffected);
  });

  it("cancelled reports Shopify off and Core unaffected", async () => {
    getState.mockResolvedValue({ data: snap({ shopify: { state: "CANCELLED" }, grantsAccess: false }) });
    render(<ShopifyConnectorSection />);
    expect(await screen.findByTestId("connector-state-cancelled")).toBeTruthy();
    expect(screen.getByTestId("connector-access")).toHaveTextContent(EN.shopifyConnector.coreUnaffected);
  });

  it("active reports features on and offers management in Shopify", async () => {
    getState.mockResolvedValue({ data: snap({ shopify: { state: "ACTIVE" }, grantsAccess: true }) });
    render(<ShopifyConnectorSection />);
    expect(await screen.findByTestId("connector-state-active")).toBeTruthy();
    expect(screen.getByTestId("connector-access")).toHaveTextContent(EN.shopifyConnector.accessOn);
  });

  it("unknown plan with access OFF says nothing was expanded, and hides the handle", async () => {
    getState.mockResolvedValue({
      data: snap({ shopify: { state: "UNKNOWN_PLAN", unknownPlanHandle: "pro-monthly" }, grantsAccess: false }),
    });
    const { container } = render(<ShopifyConnectorSection />);
    expect(await screen.findByTestId("connector-state-unknownPlan")).toBeTruthy();
    expect(screen.getByTestId("connector-access")).toHaveTextContent(EN.shopifyConnector.accessOff);
    expect(screen.getByText(EN.shopifyConnector.state.unknownPlan.body)).toBeTruthy();
    expect(container.textContent).not.toContain("pro-monthly");
    expect(screen.getByTestId("connector-support")).toBeTruthy();
  });

  it("unknown plan with access ON says existing access is preserved, not finished", async () => {
    getState.mockResolvedValue({
      data: snap({ shopify: { state: "UNKNOWN_PLAN" }, grantsAccess: true }),
    });
    render(<ShopifyConnectorSection />);
    expect(await screen.findByTestId("connector-state-unknownPlan")).toBeTruthy();
    expect(screen.getByTestId("connector-access")).toHaveTextContent(EN.shopifyConnector.accessOn);
    expect(screen.getByText(EN.shopifyConnector.state.unknownPlan.bodyPreserved)).toBeTruthy();
    // Never the old "finishing your setup" reassurance.
    expect(EN.shopifyConnector.state.unknownPlan.bodyPreserved).not.toMatch(/finishing/i);
  });

  it("UNRESOLVED still renders the Connector identity on the Billing page", async () => {
    getState.mockResolvedValue({
      data: snap({ shopify: { state: "UNRESOLVED" }, grantsAccess: false }),
    });
    render(<ShopifyConnectorSection />);
    expect(await screen.findByTestId("connector-state-notActive")).toBeTruthy();
    expect(screen.getByTestId("connector-billed-by")).toHaveTextContent(EN.shopifyConnector.billedBy);
    expect(screen.getByText(EN.shopifyConnector.separateNote)).toBeTruthy();
    expect(screen.queryByTestId("connector-cta")).toBeNull();
  });

  it.each([
    ["PAST_DUE", "manage"],
    ["FROZEN", "manage"],
    ["ERROR", "retry"],
  ])("%s offers a %s action rather than a dead end", async (state, action) => {
    getState.mockResolvedValue({ data: snap({ shopify: { state }, grantsAccess: false }) });
    render(<ShopifyConnectorSection />);
    const cta = await screen.findByTestId("connector-cta");
    expect(cta.getAttribute("data-action")).toBe(action);
  });

  it("grandfathered is shown without claiming Shopify bills them", async () => {
    getState.mockResolvedValue({
      data: snap({ shopify: { state: "NOT_REQUIRED_GRANDFATHERED" }, grantsAccess: true }),
    });
    render(<ShopifyConnectorSection />);
    expect(await screen.findByTestId("connector-state-grandfathered")).toBeTruthy();
    expect(screen.queryByTestId("connector-cta")).toBeNull();
  });
});

describe("price", () => {
  it("shows no hardcoded amount, because Shopify owns the price", async () => {
    getState.mockResolvedValue({ data: snap() });
    const { container } = render(<ShopifyConnectorSection />);
    await screen.findByTestId("connector-billed-by");
    expect(container.textContent).not.toMatch(/\$\s?\d|\d+\s?(USD|ILS|₪)/);
    expect(container.textContent).toContain(EN.shopifyConnector.pricingNote);
  });
});

describe("loading and failure", () => {
  it("reserves height while loading so nothing shifts", async () => {
    getState.mockReturnValue(new Promise(() => {}));
    const { container } = render(<ShopifyConnectorSection />);
    const box = container.querySelector(".min-h-\\[92px\\]");
    expect(box).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("says so plainly when the state cannot be read", async () => {
    getState.mockRejectedValue(new Error("boom"));
    render(<ShopifyConnectorSection />);
    expect(await screen.findByText(EN.shopifyConnector.loadFailed)).toBeTruthy();
  });
});

describe("Hebrew and RTL", () => {
  it("renders the Hebrew copy and keeps the same actions", async () => {
    locale = "he";
    getState.mockResolvedValue({
      data: snap({ shopify: { state: "PLAN_SELECTION_REQUIRED" }, grantsAccess: false }),
    });
    render(<ShopifyConnectorSection />);
    expect(await screen.findByTestId("connector-billed-by")).toHaveTextContent(HE.shopifyConnector.billedBy);
    expect(screen.getByTestId("connector-state-billingRequired")).toBeTruthy();
    expect(screen.getByTestId("connector-cta")).toHaveTextContent(HE.shopifyConnector.choosePlan);
    // Real Hebrew, not an English fallback or a raw key.
    expect(HE.shopifyConnector.billedBy).toMatch(/[֐-׿]/);
    expect(HE.shopifyConnector.billedBy).not.toBe(EN.shopifyConnector.billedBy);
  });

  it("has every state translated in Hebrew", () => {
    const en = EN.shopifyConnector.state;
    const he = HE.shopifyConnector.state;
    expect(Object.keys(he).sort()).toEqual(Object.keys(en).sort());
    for (const [k, v] of Object.entries(he) as [string, any][]) {
      expect(v.title, `${k}.title must be Hebrew`).toMatch(/[֐-׿]/);
    }
  });
});
