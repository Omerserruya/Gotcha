/**
 * The Connector state model, which both the Billing page and the Shopify
 * integration page render from.
 *
 * The rules being pinned:
 *   - OAuth finishing is NOT the same as Shopify being active
 *   - access comes from the server verdict, never re-derived here
 *   - nothing is inferred from query parameters or browser state
 *   - cancelling Shopify says nothing about GOTCHA Core
 */
import { describe, it, expect } from "vitest";
import { presentConnector } from "../shopify-connector-state";
import type { ShopifyBillingSnapshot } from "../api";

function snap(over: any = {}): ShopifyBillingSnapshot {
  return {
    core: { subscriptionStatus: "ACTIVE", planKey: "ai_workforce", billingSource: "GOTCHA_EXTERNAL" },
    installation: {
      status: "CONNECTED",
      shopDomain: "demo.myshopify.com",
      externalShopId: "123",
      connectionId: "c1",
      installedAt: "2026-01-01T00:00:00.000Z",
      uninstalledAt: null,
      ...(over.installation ?? {}),
    },
    shopify: {
      state: "ACTIVE",
      reason: "ok",
      planKey: "connector",
      planHandle: "connector",
      providerSubscriptionId: "s1",
      rawStatus: "ACTIVE",
      trialEndsAt: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      declined: false,
      unknownPlanHandle: null,
      lastVerifiedAt: null,
      ...(over.shopify ?? {}),
    },
    grandfathered: over.grandfathered ?? null,
    entitlements: over.entitlements ?? ["shopify_catalog_sync"],
    planSelectionUrl: "planSelectionUrl" in over ? over.planSelectionUrl : "https://admin.shopify.com/x/plans",
    availablePlanCount: over.availablePlanCount ?? 1,
    requiresPlanSelection: over.requiresPlanSelection ?? false,
    grantsAccess: "grantsAccess" in over ? over.grantsAccess : true,
  } as any;
}

describe("OAuth alone is never 'active'", () => {
  // The exact claim requirement 1.2.1 asks us not to make.
  it("a fully installed store with no Connector reads as billing required, not connected", () => {
    const p = presentConnector(
      snap({ shopify: { state: "PLAN_SELECTION_REQUIRED" }, grantsAccess: false }),
    );
    expect(p?.key).toBe("billingRequired");
    expect(p?.grantsAccess).toBe(false);
    expect(p?.action).toBe(true);
  });

  it("access is copied from the server verdict, not inferred from the state name", () => {
    // Even a state we call ACTIVE does not display as access-on if the server
    // says otherwise. The server is the only authority.
    const p = presentConnector(snap({ shopify: { state: "ACTIVE" }, grantsAccess: false }));
    expect(p?.key).toBe("active");
    expect(p?.grantsAccess).toBe(false);
  });

  it("credentials and a connection id alone do not grant access", () => {
    const p = presentConnector(
      snap({ shopify: { state: "PLAN_SELECTION_REQUIRED" }, grantsAccess: false, entitlements: [] }),
    );
    expect(p?.grantsAccess).toBe(false);
  });
});

describe("state mapping", () => {
  it.each([
    ["ACTIVE", "active", true],
    ["TRIALING", "trialing", true],
    ["CANCELLED", "cancelled", false],
    ["APPROVAL_PENDING", "approvalPending", false],
    ["PAST_DUE", "pastDue", false],
    ["FROZEN", "frozen", false],
    ["UNKNOWN_PLAN", "unknownPlan", true],
    ["ERROR", "unavailable", false],
    ["NOT_REQUIRED_GRANDFATHERED", "grandfathered", true],
  ])("%s maps to %s", (state, key, grants) => {
    const p = presentConnector(snap({ shopify: { state }, grantsAccess: grants }));
    expect(p?.key).toBe(key);
  });

  it("UNRESOLVED renders nothing rather than inventing a subscription", () => {
    expect(presentConnector(snap({ shopify: { state: "UNRESOLVED" } }))).toBeNull();
  });

  it("no snapshot renders nothing", () => {
    expect(presentConnector(null)).toBeNull();
  });

  it("no store connected is distinguished from unpaid", () => {
    const p = presentConnector(
      snap({ installation: { connectionId: null, shopDomain: null }, grantsAccess: false }),
    );
    expect(p?.key).toBe("notConnected");
    expect(p?.action).toBe(false);
  });

  it("an uninstalled store is not treated as connected", () => {
    const p = presentConnector(
      snap({ installation: { uninstalledAt: "2026-02-02T00:00:00.000Z" }, grantsAccess: false }),
    );
    expect(p?.key).toBe("notConnected");
  });
});

describe("unknown plan is visible and actionable", () => {
  it("names the handle so an operator can fix the catalog", () => {
    const p = presentConnector(
      snap({ shopify: { state: "UNKNOWN_PLAN", unknownPlanHandle: "pro-monthly" }, grantsAccess: true }),
    );
    expect(p?.key).toBe("unknownPlan");
    expect(p?.vars.handle).toBe("pro-monthly");
    // Never "choose a plan": the merchant is already paying Shopify.
    expect(p?.action).toBe(false);
  });
});

describe("grandfathered", () => {
  it("is represented as covered, without claiming Shopify bills them", () => {
    const p = presentConnector(
      snap({
        shopify: { state: "NOT_REQUIRED_GRANDFATHERED" },
        grandfathered: { grantedAt: "2026-01-01T00:00:00.000Z", source: "PRE_PUBLICATION", reason: "existing", paidSince: null },
        grantsAccess: true,
      }),
    );
    expect(p?.key).toBe("grandfathered");
    expect(p?.grantsAccess).toBe(true);
    expect(p?.action).toBe(false);
  });
});

describe("cancelled Connector says nothing about Core", () => {
  it("reports Shopify off while the snapshot's Core stays ACTIVE", () => {
    const s = snap({ shopify: { state: "CANCELLED" }, grantsAccess: false });
    const p = presentConnector(s);
    expect(p?.key).toBe("cancelled");
    expect(p?.grantsAccess).toBe(false);
    expect(s.core.subscriptionStatus).toBe("ACTIVE");
  });
});

describe("no state is inferred from the browser", () => {
  it("identical snapshots yield identical output regardless of URL", () => {
    const before = presentConnector(snap({ shopify: { state: "CANCELLED" }, grantsAccess: false }));
    window.history.replaceState({}, "", "/settings/billing?shopify=active&state=ACTIVE&grantsAccess=true");
    const after = presentConnector(snap({ shopify: { state: "CANCELLED" }, grantsAccess: false }));
    expect(after).toEqual(before);
    expect(after?.key).toBe("cancelled");
  });

  it("takes exactly one argument, so there is nowhere for browser state to enter", () => {
    expect(presentConnector.length).toBe(1);
  });
});

describe("the action is only offered when the SERVER supplied a destination", () => {
  it("no planSelectionUrl means no button, even when a plan is needed", () => {
    const p = presentConnector(
      snap({ shopify: { state: "PLAN_SELECTION_REQUIRED" }, planSelectionUrl: null, grantsAccess: false }),
    );
    expect(p?.key).toBe("billingRequired");
    expect(p?.action).toBe(false);
  });
});
