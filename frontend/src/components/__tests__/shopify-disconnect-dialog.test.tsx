/**
 * Disconnecting Shopify: confirm first, then wait for Shopify.
 *
 * The two claims that must never appear are "disconnected" before Shopify has
 * confirmed it, and a bare destructive button with no warning. Everything here
 * pins one of those, in both languages.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { getTranslation, t as translate, type Locale } from "@/i18n";

vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ token: "tok" }) }));

let locale: Locale = "en";
vi.mock("@/context/I18nContext", () => ({
  useI18n: () => ({
    locale,
    dir: locale === "he" ? "rtl" : "ltr",
    t: (k: string, v?: Record<string, string>) => translate(getTranslation(locale), k, v),
  }),
}));

const requestUninstall = vi.fn();
vi.mock("@/lib/api", () => ({ requestShopifyUninstall: (...a: unknown[]) => requestUninstall(...a) }));

const notify = vi.fn();
vi.mock("@/lib/integration-events", () => ({ notifyIntegrationsChanged: () => notify() }));

import ShopifyDisconnectDialog from "@/components/ShopifyDisconnectDialog";
import { presentShopifyFeatureAccess } from "@/lib/shopify-connector-state";

beforeEach(() => {
  locale = "en";
  requestUninstall.mockReset().mockResolvedValue({ data: { state: "awaiting_webhook", shopDomain: "s.myshopify.com" } });
  notify.mockReset();
});

describe.each(["en", "he"] as Locale[])("the confirmation, locale %s", (loc) => {
  it("states what stops AND what keeps working", () => {
    locale = loc;
    render(<ShopifyDisconnectDialog open shopDomain="s.myshopify.com" onCancel={() => {}} onRequested={() => {}} />);
    const tr = getTranslation(loc);
    const body = translate(tr, "marketplace.shopifyDisconnect.body");

    // What stops.
    expect(body.toLowerCase()).toMatch(/sync|סנכרון/);
    // What does NOT - the half merchants are usually not told.
    expect(body).toMatch(/Core/);
    // Reversibility, so the decision does not feel like a cliff.
    expect(body.toLowerCase()).toMatch(/reinstall|להתקין מחדש/);
    // The title and the confirm button legitimately share wording, so assert
    // the copy is present rather than that it appears exactly once.
    expect(screen.getAllByText(new RegExp(translate(tr, "marketplace.shopifyDisconnect.title"))).length)
      .toBeGreaterThan(0);
  });

  it("names the store being disconnected", () => {
    locale = loc;
    render(<ShopifyDisconnectDialog open shopDomain="s.myshopify.com" onCancel={() => {}} onRequested={() => {}} />);
    expect(screen.getByText(/s\.myshopify\.com/)).toBeTruthy();
  });

  it("the Hebrew copy is real, not an English fallback", () => {
    const en = getTranslation("en"), he = getTranslation("he");
    for (const k of ["title", "body", "confirm", "waiting", "failed"]) {
      const key = `marketplace.shopifyDisconnect.${k}`;
      expect(translate(he, key)).not.toBe(translate(en, key));
      expect(translate(he, key)).not.toBe(key);
    }
  });
});

describe("nothing happens without explicit confirmation", () => {
  it("does not call the server on render", () => {
    render(<ShopifyDisconnectDialog open shopDomain="s.myshopify.com" onCancel={() => {}} onRequested={() => {}} />);
    expect(requestUninstall).not.toHaveBeenCalled();
  });

  it("cancelling calls nothing", () => {
    const onCancel = vi.fn();
    render(<ShopifyDisconnectDialog open shopDomain="s.myshopify.com" onCancel={onCancel} onRequested={() => {}} />);
    fireEvent.click(screen.getByText(translate(getTranslation("en"), "marketplace.shopifyDisconnect.cancel")));
    expect(onCancel).toHaveBeenCalled();
    expect(requestUninstall).not.toHaveBeenCalled();
  });
});

describe("confirming", () => {
  it("calls the uninstall endpoint and reports the request, not a disconnect", async () => {
    const onRequested = vi.fn();
    render(<ShopifyDisconnectDialog open shopDomain="s.myshopify.com" onCancel={() => {}} onRequested={onRequested} />);
    fireEvent.click(screen.getByText(translate(getTranslation("en"), "marketplace.shopifyDisconnect.confirm")));
    await waitFor(() => expect(requestUninstall).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onRequested).toHaveBeenCalled());
    // Other screens must re-read rather than guess.
    expect(notify).toHaveBeenCalled();
  });

  it("a failure keeps the connection and says so, retryably", async () => {
    requestUninstall.mockRejectedValue(new Error("shopify_refused"));
    const onRequested = vi.fn();
    render(<ShopifyDisconnectDialog open shopDomain="s.myshopify.com" onCancel={() => {}} onRequested={onRequested} />);
    fireEvent.click(screen.getByText(translate(getTranslation("en"), "marketplace.shopifyDisconnect.confirm")));
    await waitFor(() => expect(screen.getByTestId("shopify-disconnect-error")).toBeTruthy());
    // Never advance to waiting on a failure: nothing is in flight.
    expect(onRequested).not.toHaveBeenCalled();
    const msg = screen.getByTestId("shopify-disconnect-error").textContent ?? "";
    expect(msg).toContain("still connected");
  });
});

describe("the waiting state is not a disconnected state", () => {
  const snap = { grantsAccess: true, entitlements: ["shopify_catalog_sync"], installation: { uninstalledAt: null } } as any;

  it("keeps the store connected and its features on while Shopify works", () => {
    // The merchant asked, Shopify has not confirmed. Switching features off
    // here would break a store that is still installed and still paid for.
    const a = presentShopifyFeatureAccess("shopify", snap, {
      integrationConnected: true, awaitingUninstall: true,
    });
    expect(a.awaitingUninstall).toBe(true);
    expect(a.featuresEnabled).toBe(true);
    expect(a.installationLabelKey).not.toContain("disconnected");
  });

  it("is false by default, so a caller cannot imply a transition it cannot see", () => {
    const a = presentShopifyFeatureAccess("shopify", snap, { integrationConnected: true });
    expect(a.awaitingUninstall).toBe(false);
  });

  it("a genuinely disconnected store is Disconnected, not waiting", () => {
    const a = presentShopifyFeatureAccess("shopify", snap, { integrationConnected: false });
    expect(a.installationLabelKey).toBe("marketplace.shopifyAccess.disconnected");
    expect(a.awaitingUninstall).toBe(false);
  });
});
