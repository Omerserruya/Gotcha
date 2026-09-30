/**
 * `grantsAccess` must never disagree with what enforcement actually does.
 *
 * FOUND IN PRODUCTION. A store was uninstalled from Shopify Admin, the
 * verified webhook revoked all four entitlements, and the snapshot still
 * reported `grantsAccess: true` - because Shopify had not finished cancelling
 * the subscription, so the row said TRIALING and the field was computed from
 * that alone. Nothing was actually granted (enforcement reads the entitlement
 * rows) and the Billing page guarded on `uninstalledAt`, so no access leaked.
 * But the field contradicted itself, and any future consumer trusting it
 * without ALSO checking the installation would have granted access to a store
 * the merchant had removed.
 */
import { describe, it, expect } from "vitest";
import { snapshotGrantsShopifyAccess } from "../services/shopify-billing-state.service";

const FOUR = [
  "shopify_catalog_sync",
  "shopify_order_read",
  "shopify_order_actions",
  "shopify_storefront_widget",
];

/** A live, paid, installed store. Each test breaks exactly one thing. */
const HEALTHY = {
  state: "ACTIVE" as const,
  installationStatus: "CONNECTED",
  uninstalledAt: null,
  entitlements: FOUR,
};

describe("the control: everything true means access", () => {
  it("connected + active + four entitlements grants access", () => {
    expect(snapshotGrantsShopifyAccess(HEALTHY)).toBe(true);
  });

  it("a trial is access too - it is an entitling state", () => {
    expect(snapshotGrantsShopifyAccess({ ...HEALTHY, state: "TRIALING" })).toBe(true);
  });
});

describe("uninstalled is terminal, whatever billing still says", () => {
  it("uninstalled + TRIALING subscription does NOT grant access", () => {
    // The exact production case.
    expect(
      snapshotGrantsShopifyAccess({
        ...HEALTHY,
        state: "TRIALING",
        uninstalledAt: new Date("2026-09-30T10:19:21.894Z"),
        entitlements: [],
      }),
    ).toBe(false);
  });

  it("uninstalled + ACTIVE subscription does NOT grant access", () => {
    expect(
      snapshotGrantsShopifyAccess({ ...HEALTHY, uninstalledAt: new Date(), entitlements: [] }),
    ).toBe(false);
  });

  it("uninstalled denies even if the entitlement rows somehow survived", () => {
    // Belt and braces: the rows are revoked by the same webhook, but a partial
    // failure must not reopen access.
    expect(snapshotGrantsShopifyAccess({ ...HEALTHY, uninstalledAt: new Date() })).toBe(false);
  });

  it("a DISCONNECTED installation does not grant access", () => {
    expect(
      snapshotGrantsShopifyAccess({ ...HEALTHY, installationStatus: "DISCONNECTED" }),
    ).toBe(false);
  });
});

describe("the field agrees with enforcement", () => {
  it("connected + active subscription but NO entitlement rows denies", () => {
    // Enforcement reads the rows. If it would deny, the snapshot must not
    // claim access - that disagreement is the whole defect.
    expect(snapshotGrantsShopifyAccess({ ...HEALTHY, entitlements: [] })).toBe(false);
  });

  it("a non-entitling subscription state denies regardless of rows", () => {
    for (const state of ["CANCELLED", "PAST_DUE", "FROZEN", "PLAN_SELECTION_REQUIRED", "UNKNOWN_PLAN", "UNRESOLVED", "ERROR"] as const) {
      expect(snapshotGrantsShopifyAccess({ ...HEALTHY, state })).toBe(false);
    }
  });
});

describe("a reinstall cannot inherit the old installation's access", () => {
  it("stays false until the new installation AND a new subscription AND rows exist", () => {
    // Freshly reinstalled: installed again, but nothing paid or granted yet.
    const reinstalled = {
      state: "PLAN_SELECTION_REQUIRED" as const,
      installationStatus: "CONNECTED",
      uninstalledAt: null,
      entitlements: [],
    };
    expect(snapshotGrantsShopifyAccess(reinstalled)).toBe(false);

    // Subscription approved but rows not yet written: still false, fail closed.
    expect(snapshotGrantsShopifyAccess({ ...reinstalled, state: "ACTIVE" })).toBe(false);

    // Only when all three are true again.
    expect(
      snapshotGrantsShopifyAccess({ ...reinstalled, state: "ACTIVE", entitlements: FOUR }),
    ).toBe(true);
  });
});
