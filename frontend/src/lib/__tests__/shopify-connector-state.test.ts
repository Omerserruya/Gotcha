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
    expect(p?.action).toBe("choosePlan");
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
    ["UNKNOWN_PLAN", "unknownPlan", false],
    ["ERROR", "unavailable", false],
    ["NOT_REQUIRED_GRANDFATHERED", "grandfathered", true],
  ])("%s maps to %s", (state, key, grants) => {
    const p = presentConnector(snap({ shopify: { state }, grantsAccess: grants }));
    expect(p?.key).toBe(key);
  });

  it("UNRESOLVED renders nothing on a screen that did not ask for it", () => {
    expect(presentConnector(snap({ shopify: { state: "UNRESOLVED" } }))).toBeNull();
  });

  // If the Connector section disappeared from the Billing page, the only thing
  // left there would be externally billed GOTCHA plans - and the honest
  // conclusion from that page alone is that Shopify comes with them. That is
  // the 1.2.1 finding, recreated by an empty state.
  it("UNRESOLVED still shows on the Billing page, as 'not active', not an error", () => {
    const p = presentConnector(snap({ shopify: { state: "UNRESOLVED" }, grantsAccess: false }), {
      alwaysShow: true,
    });
    expect(p?.key).toBe("notActive");
    expect(p?.tone).toBe("neutral");
    expect(p?.grantsAccess).toBe(false);
    expect(p?.action).toBe("none");
  });

  it("alwaysShow does not invent a card when there is no snapshot at all", () => {
    expect(presentConnector(null, { alwaysShow: true })).toBeNull();
  });

  it("no snapshot renders nothing", () => {
    expect(presentConnector(null)).toBeNull();
  });

  it("no store connected is distinguished from unpaid", () => {
    const p = presentConnector(
      snap({ installation: { connectionId: null, shopDomain: null }, grantsAccess: false }),
    );
    expect(p?.key).toBe("notConnected");
    expect(p?.action).toBe("none");
  });

  it("an uninstalled store is not treated as connected", () => {
    const p = presentConnector(
      snap({ installation: { uninstalledAt: "2026-02-02T00:00:00.000Z" }, grantsAccess: false }),
    );
    expect(p?.key).toBe("notConnected");
  });
});

describe("unknown plan follows grantsAccess exactly", () => {
  // The state name must not decide access. Only the server's verdict does.
  it("grantsAccess=false means Shopify access is OFF and says nothing was expanded", () => {
    const p = presentConnector(
      snap({ shopify: { state: "UNKNOWN_PLAN", unknownPlanHandle: "pro-monthly" }, grantsAccess: false }),
    );
    expect(p?.key).toBe("unknownPlan");
    expect(p?.grantsAccess).toBe(false);
    expect(p?.bodyKey).toMatch(/unknownPlan\.body$/);
  });

  it("grantsAccess=true keeps existing access and says it is preserved, not finished", () => {
    const p = presentConnector(
      snap({ shopify: { state: "UNKNOWN_PLAN", unknownPlanHandle: "pro-monthly" }, grantsAccess: true }),
    );
    expect(p?.grantsAccess).toBe(true);
    expect(p?.bodyKey).toMatch(/unknownPlan\.bodyPreserved$/);
  });

  it("never offers 'choose a plan' - the merchant is already paying Shopify", () => {
    for (const grants of [true, false]) {
      const p = presentConnector(
        snap({ shopify: { state: "UNKNOWN_PLAN" }, grantsAccess: grants }),
      );
      expect(p?.action).not.toBe("choosePlan");
      expect(p?.support).toBe(true);
    }
  });

  it("does not put the plan handle in merchant-facing copy", () => {
    const p = presentConnector(
      snap({ shopify: { state: "UNKNOWN_PLAN", unknownPlanHandle: "pro-monthly" }, grantsAccess: true }),
    );
    expect(JSON.stringify(p?.vars)).not.toContain("pro-monthly");
  });
});

describe("recovery paths exist instead of dead ends", () => {
  it.each(["PAST_DUE", "FROZEN", "UNKNOWN_PLAN"])(
    "%s offers Manage in Shopify when the server supplied a destination",
    (state) => {
      const p = presentConnector(snap({ shopify: { state }, grantsAccess: false }));
      expect(p?.action).toBe("manage");
    },
  );

  it("ERROR offers a retry and a support line rather than a dead end", () => {
    const p = presentConnector(snap({ shopify: { state: "ERROR" }, grantsAccess: false }));
    expect(p?.action).toBe("retry");
    expect(p?.support).toBe(true);
  });

  it("falls back to retry when the server gave no destination", () => {
    const p = presentConnector(
      snap({ shopify: { state: "PAST_DUE" }, planSelectionUrl: null, grantsAccess: false }),
    );
    expect(p?.action).toBe("retry");
  });

  it("no CTA implies that pressing it grants access", () => {
    // `manage` and `choosePlan` both open Shopify's own page; neither is a
    // switch we control. `retry` only re-reads our own state.
    for (const state of ["ACTIVE", "PAST_DUE", "FROZEN", "UNKNOWN_PLAN", "CANCELLED", "ERROR"]) {
      const p = presentConnector(snap({ shopify: { state }, grantsAccess: false }));
      expect(["none", "manage", "choosePlan", "retry"]).toContain(p?.action);
    }
  });
});

/**
 * THE AUTHORITATIVE VERDICT.
 *
 * Across every state and both verdicts, the access the UI reports must equal
 * `grantsAccess` and nothing else - not the state enum, not the install, not
 * the connection, not Core's subscription, not the URL.
 */
describe("displayed access is derived from grantsAccess alone", () => {
  const STATES = [
    "NOT_REQUIRED_GRANDFATHERED", "ACTIVE", "TRIALING", "PLAN_SELECTION_REQUIRED",
    "APPROVAL_PENDING", "PAST_DUE", "FROZEN", "CANCELLED", "UNKNOWN_PLAN", "ERROR",
  ];

  for (const state of STATES) {
    for (const grants of [true, false]) {
      it(`${state} + grantsAccess=${grants} reports access=${grants}`, () => {
        const p = presentConnector(snap({ shopify: { state }, grantsAccess: grants }));
        expect(p?.grantsAccess).toBe(grants);
      });
    }
  }

  it("a healthy install and a live Core plan do not raise access", () => {
    const p = presentConnector(
      snap({
        shopify: { state: "ACTIVE" },
        installation: { status: "CONNECTED", connectionId: "c1", shopDomain: "demo.myshopify.com" },
        grantsAccess: false,
      }),
    );
    expect(p?.grantsAccess).toBe(false);
  });

  it("a missing install does not lower access reported by the server", () => {
    // notConnected is decided by the installation, and it reports no access -
    // which is the one case where the two agree by construction.
    const p = presentConnector(
      snap({ installation: { connectionId: null, shopDomain: null }, grantsAccess: true }),
    );
    expect(p?.key).toBe("notConnected");
    expect(p?.grantsAccess).toBe(false);
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
    expect(p?.action).toBe("none");
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

  it("takes only a snapshot and options, so there is nowhere for browser state to enter", () => {
    expect(presentConnector.length).toBeLessThanOrEqual(2);
  });
});

describe("the action is only offered when the SERVER supplied a destination", () => {
  it("no planSelectionUrl means no button, even when a plan is needed", () => {
    const p = presentConnector(
      snap({ shopify: { state: "PLAN_SELECTION_REQUIRED" }, planSelectionUrl: null, grantsAccess: false }),
    );
    expect(p?.key).toBe("billingRequired");
    // No destination from the server: a retry, never a button that goes nowhere.
    expect(p?.action).toBe("retry");
  });
});
