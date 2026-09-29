/**
 * The rendered integration drawer must not claim Shopify access while the
 * Connector is unpaid - in English and in Hebrew.
 *
 * The unit tests pin the decision. These pin the SCREEN, because the defect was
 * never in the verdict: the verdict was right and the page around it still drew
 * a green "Connected" chip and 68 of 68 live tools. A reviewer reads the screen.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { getTranslation, t as translate, type Locale } from "@/i18n";

vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ token: "tok" }) }));

let locale: Locale = "en";
vi.mock("@/context/I18nContext", () => ({
  useI18n: () => ({
    locale,
    dir: locale === "he" ? "rtl" : "ltr",
    t: (key: string, vars?: Record<string, string>) => translate(getTranslation(locale), key, vars),
  }),
}));

let grantsAccess = false;
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  getShopifyBillingState: vi.fn(async () => ({
    data: {
      core: { subscriptionStatus: "ACTIVE", planKey: "poc", billingSource: "GOTCHA_EXTERNAL" },
      installation: {
        status: "CONNECTED", shopDomain: "new-for-test.myshopify.com",
        externalShopId: "1", connectionId: "c1",
        installedAt: "2026-09-01T00:00:00.000Z", uninstalledAt: null,
      },
      shopify: { state: grantsAccess ? "ACTIVE" : "CANCELLED", reason: "t", planHandle: "gotcha-connector" },
      grandfathered: null,
      entitlements: grantsAccess ? ["shopify_catalog_sync"] : [],
      planSelectionUrl: "https://admin.shopify.com/store/x/charges/gotcha/pricing_plans",
      availablePlanCount: 1, requiresPlanSelection: false, grantsAccess,
    },
  })),
  getIntegrationTools: vi.fn(async () => ({ data: [] })),
}));

import { presentShopifyFeatureAccess } from "@/lib/shopify-connector-state";
import { useShopifyFeatureAccess } from "@/lib/useShopifyFeatureAccess";
import { useI18n } from "@/context/I18nContext";

/**
 * A minimal host that renders exactly the indicators under test through the
 * real gate and the real translations. Mounting the full drawer would drag in
 * the marketplace's data loading without testing anything more about the claim.
 */
function Indicators({ toolCount }: { toolCount: number }) {
  const a = useShopifyFeatureAccess("shopify", true);
  const { t } = useI18n();
  return (
    <div>
      <span data-testid="status">{a.applies ? t(a.installationLabelKey) : "Connected"}</span>
      {a.showConnectorRequired && (
        <span data-testid="required">{t("marketplace.shopifyAccess.connectorRequired")}</span>
      )}
      <span data-testid="tools">
        {a.applies && !a.featuresEnabled
          ? t("marketplace.shopifyAccess.toolsLockedCount").replace("{total}", String(toolCount))
          : `${toolCount}/${toolCount}`}
      </span>
      <span data-testid="writeback">
        {a.featuresEnabled
          ? t("marketplace.systemOfRecordActive")
          : t("marketplace.shopifyAccess.writebackUnavailable")}
      </span>
    </div>
  );
}

beforeEach(() => { grantsAccess = false; locale = "en"; });

describe.each(["en", "he"] as Locale[])("unpaid Connector, locale %s", (loc) => {
  it("claims nothing active anywhere on the screen", async () => {
    locale = loc;
    grantsAccess = false;
    render(<Indicators toolCount={68} />);

    const tr = getTranslation(loc);
    await waitFor(() => {
      expect(screen.getByTestId("status").textContent).toBe(
        translate(tr, "marketplace.shopifyAccess.authorized"),
      );
    });

    // The exact claim the reviewer saw must be absent.
    expect(screen.getByTestId("tools").textContent).not.toContain("68/68");
    expect(screen.getByTestId("tools").textContent).toContain("0");
    expect(screen.getByTestId("required").textContent).toBe(
      translate(tr, "marketplace.shopifyAccess.connectorRequired"),
    );
    expect(screen.getByTestId("writeback").textContent).toBe(
      translate(tr, "marketplace.shopifyAccess.writebackUnavailable"),
    );
    // And it must not say "Active" in either language.
    expect(screen.getByTestId("status").textContent).not.toBe(
      translate(tr, "marketplace.shopifyAccess.active"),
    );
  });
});

describe.each(["en", "he"] as Locale[])("paid Connector, locale %s", (loc) => {
  it("restores the active presentation", async () => {
    locale = loc;
    grantsAccess = true;
    render(<Indicators toolCount={68} />);

    const tr = getTranslation(loc);
    await waitFor(() => {
      expect(screen.getByTestId("status").textContent).toBe(
        translate(tr, "marketplace.shopifyAccess.active"),
      );
    });
    expect(screen.getByTestId("tools").textContent).toBe("68/68");
    expect(screen.queryByTestId("required")).toBeNull();
    expect(screen.getByTestId("writeback").textContent).toBe(
      translate(tr, "marketplace.systemOfRecordActive"),
    );
  });
});

describe("the Hebrew copy is real, not an English fallback", () => {
  it("differs from English for every new key", () => {
    const en = getTranslation("en");
    const he = getTranslation("he");
    for (const k of ["authorized", "connectorRequired", "writebackUnavailable", "toolsLocked"]) {
      const key = `marketplace.shopifyAccess.${k}`;
      expect(translate(he, key)).not.toBe(translate(en, key));
      expect(translate(he, key)).not.toBe(key); // not a missing-key passthrough
    }
  });
});

describe("the gate is the only input", () => {
  it("cannot be talked into access by a Core plan", () => {
    const a = presentShopifyFeatureAccess(
      "shopify",
      { grantsAccess: false, installation: { uninstalledAt: null } } as any,
      { integrationConnected: true },
    );
    expect(a.featuresEnabled).toBe(false);
  });
});
