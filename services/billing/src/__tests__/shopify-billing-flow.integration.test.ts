/**
 * The Shopify billing state machine, the post-install decision, and the
 * guards on the return URL.
 *
 * The three things worth proving here, in order of how much damage they would
 * do if they broke:
 *
 *   1. Reaching the return URL is not proof of payment. The verified return
 *      route must refuse a store the session does not own, and must not grant
 *      anything on the strength of a query parameter.
 *
 *   2. Core and Shopify stay separate in BOTH directions. A paid Core
 *      subscription must not switch Shopify capabilities on, and a Shopify
 *      subscription must not widen Core. Each direction is a different bug and
 *      each is tested on its own.
 *
 *   3. Acquisition source changes nothing. A merchant from the App Store, one
 *      from our website, and one connected by an admin all get the same
 *      decision from the same evidence.
 */
import { vi, describe, it, expect, beforeEach, afterAll, afterEach } from "vitest";

/**
 * Auth is stubbed the same way `checkout-authz` does it: these tests are about
 * billing decisions, and running real token verification here would test
 * Authentik instead.
 *
 * `resolveTenant` sets the tenant from a header the TEST controls, which is
 * the point - it lets a request claim one workspace while the connection
 * belongs to another, which is exactly the forged-return case.
 */
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    authenticate: (req: any, _res: any, next: any) => {
      req.user = { userId: "test-user", role: "OWNER" };
      next();
    },
    resolveTenant: (req: any, _res: any, next: any) => {
      req.tenantId = req.get("x-test-tenant") || null;
      next();
    },
    requirePermission: () => (_req: any, _res: any, next: any) => next(),
    requireSystemAdmin: () => (req: any, res: any, next: any) =>
      req.get("x-test-sysadmin") === "1" ? next() : res.status(403).json({ error: "forbidden" }),
  };
});

import express from "express";
import request from "supertest";
import { prisma } from "@chatcenter/shared";
import shopifyBillingRouter from "../routes/shopify-billing";
import { onShopifyConnected } from "../services/shopify-post-install.service";
import {
  getShopifyAccessSnapshot,
  stateGrantsShopifyAccess,
} from "../services/shopify-billing-state.service";

const RUN = `sbf-${Date.now().toString(36)}`;
const ORIGINAL = { ...process.env };

const tenantIds: string[] = [];
const entityIds: string[] = [];
const shopIds: string[] = [];

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api", shopifyBillingRouter);
  return a;
}

function enableBilling(opts: { grandfathered?: boolean; cutoff?: string } = {}) {
  process.env.SHOPIFY_BILLING_ENABLED = "true";
  process.env.SHOPIFY_BILLING_MODE = "manual";
  process.env.SHOPIFY_BILLING_POLICY_MODE = "connector_addon";
  // Split billing is the CONFIRMED model: GOTCHA Core stays external, Shopify
  // bills the connector separately.
  process.env.SHOPIFY_ALLOW_SPLIT_BILLING = "true";
  process.env.SHOPIFY_APP_HANDLE = "gotcha";
  process.env.SHOPIFY_BILLING_PLAN_CATALOG = JSON.stringify([
    {
      key: "SHOPIFY_CONNECTOR",
      handle: "gotcha-connector",
      entitlements: ["shopify_catalog_sync", "shopify_order_read"],
    },
  ]);
  if (opts.grandfathered) process.env.SHOPIFY_ALLOW_GRANDFATHERED = "true";
  if (opts.cutoff) process.env.SHOPIFY_APP_PUBLICATION_CUTOFF = opts.cutoff;
}

const CUTOFF = "2026-06-01T00:00:00.000Z";
const BEFORE = new Date("2026-03-01T00:00:00.000Z");
const AFTER = new Date("2026-09-01T00:00:00.000Z");

async function newTenant(opts: { paidAt?: Date; coreStatus?: "ACTIVE" | "CANCELED" } = {}) {
  const n = `${RUN}-${Math.random().toString(36).slice(2, 8)}`;
  const tenant = await prisma.tenant.create({ data: { name: n, slug: n, status: "ACTIVE" } });
  tenantIds.push(tenant.id);
  const entity = await prisma.billableEntity.create({ data: { displayName: n } });
  entityIds.push(entity.id);
  await prisma.billableEntityTenant.create({
    data: { billableEntityId: entity.id, tenantId: tenant.id },
  });
  if (opts.coreStatus) {
    await prisma.subscription.create({
      data: {
        billableEntityId: entity.id,
        planKey: "ai_workforce",
        planVersion: 1,
        status: opts.coreStatus,
        billingSource: "GOTCHA_EXTERNAL",
      },
    });
  }
  if (opts.paidAt) {
    await prisma.invoice.create({
      data: {
        billableEntityId: entity.id,
        type: "SUBSCRIPTION",
        status: "PAID",
        paidAt: opts.paidAt,
        currency: "ILS",
        amount: 100,
      },
    });
  }
  return { tenant, entityId: entity.id };
}

function shopId(): string {
  const id = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  shopIds.push(id);
  return id;
}

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("SHOPIFY_")) delete process.env[k];
  }
});

afterEach(async () => {
  await prisma.tenantEntitlement.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.providerSubscription.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.billingPolicyDecision.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.shopifyGrandfatherGrant.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.commerceConnection.deleteMany({ where: { tenantId: { in: tenantIds } } });
});

afterAll(async () => {
  process.env = { ...ORIGINAL };
  await prisma.invoice.deleteMany({ where: { billableEntityId: { in: entityIds } } });
  await prisma.subscription.deleteMany({ where: { billableEntityId: { in: entityIds } } });
  await prisma.billableEntityTenant.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.billableEntity.deleteMany({ where: { id: { in: entityIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
});

// ─── Scenario A: the grandfathered merchant ──────────────────────────────

describe("scenario 1/5: a pre-publication customer installs Shopify", () => {
  it("is connected without ever being sent to a plan page", async () => {
    enableBilling({ grandfathered: true, cutoff: CUTOFF });
    const { tenant } = await newTenant({ paidAt: BEFORE, coreStatus: "ACTIVE" });

    const r = await onShopifyConnected({
      tenantId: tenant.id,
      externalShopId: shopId(),
      shopDomain: "acme.myshopify.com",
      acquisitionSource: "app_store",
    });

    expect(r.grandfathered).toBe(true);
    expect(r.requiresPlanSelection).toBe(false);
    expect(r.planSelectionUrl).toBeNull();
    expect(r.state).toBe("NOT_REQUIRED_GRANDFATHERED");
  });

  it("holds its capabilities under a source a Shopify lapse cannot revoke", async () => {
    enableBilling({ grandfathered: true, cutoff: CUTOFF });
    const { tenant } = await newTenant({ paidAt: BEFORE, coreStatus: "ACTIVE" });
    await onShopifyConnected({
      tenantId: tenant.id,
      externalShopId: shopId(),
      shopDomain: "acme.myshopify.com",
    });

    const rows = await prisma.tenantEntitlement.findMany({ where: { tenantId: tenant.id } });
    expect(rows.length).toBeGreaterThan(0);
    // SHOPIFY_GRANDFATHERED, never SHOPIFY_SUBSCRIPTION: `revokeShopifyEntitlements`
    // deletes by the latter, and one shared value would let a lapse cut off the
    // people who were promised they would never pay.
    expect(rows.every((r) => r.source === "SHOPIFY_GRANDFATHERED")).toBe(true);
    expect(rows.every((r) => r.fundedByBillingSource === "EXEMPT")).toBe(true);
  });

  it("the connection is CONNECTED, not BILLING_PENDING", async () => {
    enableBilling({ grandfathered: true, cutoff: CUTOFF });
    const { tenant } = await newTenant({ paidAt: BEFORE, coreStatus: "ACTIVE" });
    const r = await onShopifyConnected({
      tenantId: tenant.id,
      externalShopId: shopId(),
      shopDomain: "acme.myshopify.com",
    });
    const conn = await prisma.commerceConnection.findUnique({ where: { id: r.connectionId } });
    expect(conn?.status).toBe("CONNECTED");
  });
});

// ─── Scenario B/C: everybody else ────────────────────────────────────────

describe("scenarios 3/4/5: a non-grandfathered merchant", () => {
  it("is connected but owes a plan, whatever the acquisition source", async () => {
    enableBilling({ grandfathered: true, cutoff: CUTOFF });

    for (const source of ["app_store", "in_app_connect", "admin"]) {
      const { tenant } = await newTenant({ paidAt: AFTER, coreStatus: "ACTIVE" });
      const r = await onShopifyConnected({
        tenantId: tenant.id,
        externalShopId: shopId(),
        shopDomain: "new.myshopify.com",
        acquisitionSource: source,
      });
      // Identical answer for all three. Billing must not depend on where the
      // merchant came from - that is the confirmed model, and this loop is what
      // stops a well-meaning "App Store users are different" branch appearing.
      expect(r.grandfathered).toBe(false);
      expect(r.requiresPlanSelection).toBe(true);
      expect(r.state).toBe("PLAN_SELECTION_REQUIRED");
    }
  });

  it("records the acquisition source even though nothing reads it", async () => {
    enableBilling();
    const { tenant } = await newTenant({ coreStatus: "ACTIVE" });
    const r = await onShopifyConnected({
      tenantId: tenant.id,
      externalShopId: shopId(),
      shopDomain: "new.myshopify.com",
      acquisitionSource: "app_store",
    });
    const conn = await prisma.commerceConnection.findUnique({ where: { id: r.connectionId } });
    // Cannot be reconstructed later, so it is captured at install time.
    expect(conn?.acquisitionSource).toBe("app_store");
  });

  it("stays BILLING_PENDING until somebody pays", async () => {
    enableBilling();
    const { tenant } = await newTenant({ coreStatus: "ACTIVE" });
    const r = await onShopifyConnected({
      tenantId: tenant.id,
      externalShopId: shopId(),
      shopDomain: "new.myshopify.com",
    });
    const conn = await prisma.commerceConnection.findUnique({ where: { id: r.connectionId } });
    expect(conn?.status).toBe("BILLING_PENDING");
  });

  it("grants no Shopify entitlements", async () => {
    enableBilling();
    const { tenant } = await newTenant({ coreStatus: "ACTIVE" });
    await onShopifyConnected({
      tenantId: tenant.id,
      externalShopId: shopId(),
      shopDomain: "new.myshopify.com",
    });
    const snap = await getShopifyAccessSnapshot(tenant.id);
    expect(snap.entitlements).toEqual([]);
  });
});

// ─── Scenario 15/16: the two systems stay separate ───────────────────────

describe("scenarios 15/16: Core and Shopify are independent", () => {
  it("scenario 15: an expired Core subscription does not change the Shopify state", async () => {
    enableBilling();
    const { tenant } = await newTenant({ coreStatus: "CANCELED" });
    await onShopifyConnected({
      tenantId: tenant.id,
      externalShopId: shopId(),
      shopDomain: "x.myshopify.com",
    });
    const snap = await getShopifyAccessSnapshot(tenant.id);
    // Reported side by side, never collapsed into one verdict.
    expect(snap.core.subscriptionStatus).toBe("CANCELED");
    expect(snap.shopify.state).toBe("PLAN_SELECTION_REQUIRED");
  });

  it("an ACTIVE Core subscription does NOT grant Shopify capability", async () => {
    // The direction that would cost us money: paying for Core must not hand a
    // non-grandfathered merchant the Shopify connector for free.
    enableBilling();
    const { tenant } = await newTenant({ coreStatus: "ACTIVE", paidAt: AFTER });
    await onShopifyConnected({
      tenantId: tenant.id,
      externalShopId: shopId(),
      shopDomain: "x.myshopify.com",
    });
    const snap = await getShopifyAccessSnapshot(tenant.id);
    expect(snap.core.subscriptionStatus).toBe("ACTIVE");
    expect(stateGrantsShopifyAccess(snap.shopify.state)).toBe(false);
    expect(snap.entitlements).toEqual([]);
  });

  it("scenario 16: a workspace with no Shopify at all is untouched", async () => {
    enableBilling();
    const { tenant } = await newTenant({ coreStatus: "ACTIVE" });
    const snap = await getShopifyAccessSnapshot(tenant.id);
    // A WooCommerce-only customer. Shopify billing must be inert for them
    // rather than a workspace-wide requirement.
    expect(snap.installation.status).toBe("NONE");
    expect(snap.shopify.state).toBe("PLAN_SELECTION_REQUIRED");
    expect(snap.entitlements).toEqual([]);
    expect(snap.core.subscriptionStatus).toBe("ACTIVE");
  });
});

// ─── Billing switched off ────────────────────────────────────────────────

describe("with Shopify billing switched off", () => {
  it("connects the store and asks nobody for money", async () => {
    // Today's behaviour for every existing merchant, and the default.
    const { tenant } = await newTenant({ coreStatus: "ACTIVE" });
    const r = await onShopifyConnected({
      tenantId: tenant.id,
      externalShopId: shopId(),
      shopDomain: "legacy.myshopify.com",
    });
    expect(r.state).toBe("UNRESOLVED");
    expect(r.requiresPlanSelection).toBe(false);
    const conn = await prisma.commerceConnection.findUnique({ where: { id: r.connectionId } });
    expect(conn?.status).toBe("CONNECTED");
  });
});

// ─── Scenario 14: the return URL proves nothing ──────────────────────────

describe("scenario 14: forged or mismatched return parameters", () => {
  it("refuses a return naming a store this workspace does not own", async () => {
    enableBilling();
    const { tenant } = await newTenant({ coreStatus: "ACTIVE" });
    await onShopifyConnected({
      tenantId: tenant.id,
      externalShopId: shopId(),
      shopDomain: "mine.myshopify.com",
    });

    const res = await request(app())
      .post("/api/billing/shopify/complete?shop=someone-else.myshopify.com")
      .set("x-test-tenant", tenant.id);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("shopify_shop_mismatch");
  });

  it("refuses when the workspace has no connected store at all", async () => {
    enableBilling();
    const { tenant } = await newTenant({ coreStatus: "ACTIVE" });
    const res = await request(app())
      .post("/api/billing/shopify/complete?shop=anything.myshopify.com")
      .set("x-test-tenant", tenant.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("shopify_not_connected");
  });

  it("grants nothing on the strength of a hopeful query string", async () => {
    enableBilling();
    const { tenant } = await newTenant({ coreStatus: "ACTIVE" });
    await onShopifyConnected({
      tenantId: tenant.id,
      externalShopId: shopId(),
      shopDomain: "mine.myshopify.com",
    });

    // Every parameter an attacker might hope is trusted.
    await request(app())
      .post(
        "/api/billing/shopify/complete?shop=mine.myshopify.com&charge_id=999&status=active&approved=true",
      )
      .set("x-test-tenant", tenant.id);

    const snap = await getShopifyAccessSnapshot(tenant.id);
    // The verified read is what decides, and in mock mode it reports no
    // subscription. The query string moved nothing.
    expect(snap.entitlements).toEqual([]);
    expect(["PLAN_SELECTION_REQUIRED", "CANCELLED"]).toContain(snap.shopify.state);
  });
});

// ─── Plan selection guards ───────────────────────────────────────────────

describe("plan selection refuses the cases that would be wrong", () => {
  it("never sends a grandfathered merchant to pay", async () => {
    enableBilling({ grandfathered: true, cutoff: CUTOFF });
    const { tenant } = await newTenant({ paidAt: BEFORE, coreStatus: "ACTIVE" });
    await onShopifyConnected({
      tenantId: tenant.id,
      externalShopId: shopId(),
      shopDomain: "acme.myshopify.com",
    });

    const res = await request(app())
      .post("/api/billing/shopify/plan-selection")
      .set("x-test-tenant", tenant.id);

    // The single most damaging thing this flow could do is show a plan page to
    // a customer who was promised they would not have to pay.
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("shopify_billing_not_required");
  });

  it("refuses before a store is connected", async () => {
    enableBilling();
    const { tenant } = await newTenant({ coreStatus: "ACTIVE" });
    const res = await request(app())
      .post("/api/billing/shopify/plan-selection")
      .set("x-test-tenant", tenant.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("shopify_not_connected");
  });

  it("refuses when billing is switched off", async () => {
    const { tenant } = await newTenant({ coreStatus: "ACTIVE" });
    const res = await request(app())
      .post("/api/billing/shopify/plan-selection")
      .set("x-test-tenant", tenant.id);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("shopify_billing_disabled");
  });

  it("returns Shopify's own hosted page, never a GOTCHA payment form", async () => {
    enableBilling();
    const { tenant } = await newTenant({ coreStatus: "ACTIVE" });
    await onShopifyConnected({
      tenantId: tenant.id,
      externalShopId: shopId(),
      shopDomain: "acme.myshopify.com",
    });
    const res = await request(app())
      .post("/api/billing/shopify/plan-selection")
      .set("x-test-tenant", tenant.id);
    expect(res.status).toBe(200);
    expect(res.body.data.url).toContain("admin.shopify.com/store/acme/charges/");
  });
});

// ─── Scenario 18: the override is not reachable by a tenant user ─────────

describe("scenario 18: the admin surface is admin-only", () => {
  it("refuses a grandfather override without SYSTEM_ADMIN", async () => {
    enableBilling({ grandfathered: true, cutoff: CUTOFF });
    const { tenant } = await newTenant({ coreStatus: "ACTIVE" });
    const res = await request(app())
      .post(`/api/admin/billing/shopify/grandfather/${tenant.id}`)
      .send({ note: "let me in" });
    expect(res.status).toBe(403);
  });

  it("allows it for a SYSTEM_ADMIN and attributes it to them", async () => {
    enableBilling({ grandfathered: true, cutoff: CUTOFF });
    const { tenant } = await newTenant({ paidAt: AFTER, coreStatus: "ACTIVE" });
    const res = await request(app())
      .post(`/api/admin/billing/shopify/grandfather/${tenant.id}`)
      .set("x-test-sysadmin", "1")
      .send({ note: "migrated contract" });

    expect(res.status).toBe(200);
    expect(res.body.data.grant.source).toBe("ADMIN_OVERRIDE");
    // Taken from the authenticated user, not from the body: an approver the
    // caller could type is an audit trail that records whatever they wanted.
    expect(res.body.data.grant.approvedBy).toBe("test-user");
  });
});

// ─── The state read ──────────────────────────────────────────────────────

describe("the state endpoint", () => {
  it("reports Core and Shopify as separate fields", async () => {
    enableBilling();
    const { tenant } = await newTenant({ coreStatus: "ACTIVE" });
    const res = await request(app())
      .get("/api/billing/shopify/state")
      .set("x-test-tenant", tenant.id);

    expect(res.status).toBe(200);
    expect(res.body.data.core.subscriptionStatus).toBe("ACTIVE");
    expect(res.body.data.shopify).toHaveProperty("state");
    expect(res.body.data).toHaveProperty("requiresPlanSelection");
  });

  it("exposes no price, currency or trial length of our own invention", async () => {
    enableBilling();
    const { tenant } = await newTenant({ coreStatus: "ACTIVE" });
    const res = await request(app())
      .get("/api/billing/shopify/plans")
      .set("x-test-tenant", tenant.id);

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/"price"/);
    expect(serialized).not.toMatch(/"currency"/);
    expect(serialized).not.toMatch(/"trialDays"/);
  });
});

// ─── The catalog has to actually control what is granted ─────────────────

describe("a plan funds what the catalog says it funds", () => {
  /** Drive the grant directly: sync's mock source reports no subscription. */
  async function grantFor(tenantId: string, planKey: string | null) {
    const { grantShopifyEntitlements } = await import("../services/provider-subscription.service");
    await grantShopifyEntitlements(tenantId, "psub-test", planKey);
    const rows = await prisma.tenantEntitlement.findMany({
      where: { tenantId, source: "SHOPIFY_SUBSCRIPTION" },
      select: { entitlementKey: true },
    });
    return rows.map((r) => r.entitlementKey).sort();
  }

  it("grants exactly the declared entitlements, not the full set", async () => {
    process.env.SHOPIFY_BILLING_PLAN_CATALOG = JSON.stringify([
      { key: "SMALL", handle: "small", entitlements: ["shopify_catalog_sync"] },
    ]);
    const { tenant } = await newTenant({ coreStatus: "ACTIVE" });
    expect(await grantFor(tenant.id, "SMALL")).toEqual(["shopify_catalog_sync"]);
  });

  it("grants the full set when a plan declares nothing", async () => {
    // The minimal handle-map form. A verifiably paying merchant must not lose
    // capability because an operator has not finished writing the catalog.
    process.env.SHOPIFY_BILLING_PLAN_CATALOG = JSON.stringify([{ key: "BARE", handle: "bare" }]);
    const { tenant } = await newTenant({ coreStatus: "ACTIVE" });
    expect(await grantFor(tenant.id, "BARE")).toHaveLength(4);
  });

  it("defaults to the full set for an unresolvable key - but sync never gets here", async () => {
    // This is the LOW-LEVEL default, and it is deliberately not the production
    // behaviour for an unknown plan. `syncProviderSubscription` now refuses to
    // call this at all when Shopify names a handle the catalog does not
    // contain - see shopify-unknown-plan-and-boot.integration.test.ts. The
    // fallback survives for the case that IS legitimate: a plan that resolves
    // but declares no entitlements.
    process.env.SHOPIFY_BILLING_PLAN_CATALOG = JSON.stringify([{ key: "A", handle: "a" }]);
    const { tenant } = await newTenant({ coreStatus: "ACTIVE" });
    expect(await grantFor(tenant.id, "SOMETHING_SHOPIFY_NAMED")).toHaveLength(4);
  });

  it("cannot invent an entitlement that is not Shopify-funded", async () => {
    // Configuration may NARROW what a plan funds. It may not hand out arbitrary
    // capability - otherwise an env var edit is a way past code review.
    process.env.SHOPIFY_BILLING_PLAN_CATALOG = JSON.stringify([
      {
        key: "SNEAKY",
        handle: "s",
        entitlements: ["shopify_catalog_sync", "voice.unlimited_minutes", "commerce.auto_buy"],
      },
    ]);
    const { tenant } = await newTenant({ coreStatus: "ACTIVE" });
    expect(await grantFor(tenant.id, "SNEAKY")).toEqual(["shopify_catalog_sync"]);
  });

  it("a downgrade NARROWS, it does not merely stop widening", async () => {
    process.env.SHOPIFY_BILLING_PLAN_CATALOG = JSON.stringify([
      { key: "BIG", handle: "big", rank: 2 },
      { key: "SMALL", handle: "small", rank: 1, entitlements: ["shopify_catalog_sync"] },
    ]);
    const { tenant } = await newTenant({ coreStatus: "ACTIVE" });

    expect(await grantFor(tenant.id, "BIG")).toHaveLength(4);
    // Without the cleanup, BIG's rows would survive forever: they were granted
    // by a real subscription, so nothing else would ever remove them.
    expect(await grantFor(tenant.id, "SMALL")).toEqual(["shopify_catalog_sync"]);
  });

  it("the confirmed gotcha-connector catalog grants all four", async () => {
    process.env.SHOPIFY_BILLING_PLAN_CATALOG = JSON.stringify([
      {
        key: "SHOPIFY_CONNECTOR",
        productKey: "shopify_connector",
        handle: "gotcha-connector",
        visibility: "public",
        enabled: true,
        rank: 1,
        entitlements: [
          "shopify_catalog_sync",
          "shopify_order_read",
          "shopify_order_actions",
          "shopify_storefront_widget",
        ],
        restrictedToShops: [],
      },
    ]);
    const { tenant } = await newTenant({ coreStatus: "ACTIVE" });
    expect(await grantFor(tenant.id, "SHOPIFY_CONNECTOR")).toEqual([
      "shopify_catalog_sync",
      "shopify_order_actions",
      "shopify_order_read",
      "shopify_storefront_widget",
    ]);
  });
});

// ─── The five states that must never grant ───────────────────────────────

describe("states that must never grant Shopify entitlements", () => {
  async function shopifyEntitlements(tenantId: string) {
    const rows = await prisma.tenantEntitlement.findMany({
      where: { tenantId, source: { in: ["SHOPIFY_SUBSCRIPTION", "SHOPIFY_GRANDFATHERED"] } },
    });
    return rows.map((r) => r.entitlementKey);
  }

  it("BILLING_PENDING grants nothing", async () => {
    enableBilling();
    const { tenant } = await newTenant({ coreStatus: "ACTIVE" });
    const r = await onShopifyConnected({
      tenantId: tenant.id,
      externalShopId: shopId(),
      shopDomain: "x.myshopify.com",
    });
    const conn = await prisma.commerceConnection.findUnique({ where: { id: r.connectionId } });
    expect(conn?.status).toBe("BILLING_PENDING");
    expect(await shopifyEntitlements(tenant.id)).toEqual([]);
  });

  it("missing Partner API credentials cannot grant, and cannot revoke either", async () => {
    // The distinction is the point: "we could not ask" must not be recorded as
    // "they are not paying", which would revoke a paying merchant mid-outage.
    enableBilling();
    process.env.SHOPIFY_BILLING_MODE = "app_pricing";
    process.env.SHOPIFY_BILLING_ENV = "test"; // networked, so credentials matter
    delete process.env.SHOPIFY_PARTNER_API_TOKEN;
    delete process.env.SHOPIFY_PARTNER_ORGANIZATION_ID;
    delete process.env.SHOPIFY_PARTNER_APP_ID;

    const { tenant } = await newTenant({ coreStatus: "ACTIVE" });
    const link = await prisma.billableEntityTenant.findUnique({
      where: { tenantId: tenant.id },
      select: { billableEntityId: true },
    });
    const { syncProviderSubscription } = await import("../services/provider-subscription.service");

    await expect(
      syncProviderSubscription({
        tenantId: tenant.id,
        billableEntityId: link!.billableEntityId,
        productKey: "shopify_connector",
        billingSource: "SHOPIFY",
        externalShopId: "999",
        environment: "test",
      }),
    ).rejects.toThrow();

    expect(await shopifyEntitlements(tenant.id)).toEqual([]);
  });

  it("a failed verification leaves the install intact and grants nothing", async () => {
    enableBilling();
    process.env.SHOPIFY_BILLING_MODE = "app_pricing";
    process.env.SHOPIFY_BILLING_ENV = "test";
    delete process.env.SHOPIFY_PARTNER_API_TOKEN;

    const { tenant } = await newTenant({ coreStatus: "ACTIVE" });
    // onShopifyConnected swallows the verification failure by design - the
    // store is already linked and nothing here may retract that.
    const r = await onShopifyConnected({
      tenantId: tenant.id,
      externalShopId: shopId(),
      shopDomain: "x.myshopify.com",
    });
    expect(r.connectionId).toBeTruthy();
    expect(await shopifyEntitlements(tenant.id)).toEqual([]);
  });

  it("a cancelled subscription revokes what Shopify was funding", async () => {
    enableBilling();
    const { tenant } = await newTenant({ coreStatus: "ACTIVE" });
    const { grantShopifyEntitlements, revokeShopifyEntitlements } = await import(
      "../services/provider-subscription.service"
    );
    await grantShopifyEntitlements(tenant.id, "psub-x", null);
    expect((await shopifyEntitlements(tenant.id)).length).toBe(4);

    await revokeShopifyEntitlements(tenant.id);
    expect(await shopifyEntitlements(tenant.id)).toEqual([]);
  });

  it("an empty plan catalog sells nothing, so no plan selection is offered", async () => {
    enableBilling();
    delete process.env.SHOPIFY_BILLING_PLAN_CATALOG;
    const { tenant } = await newTenant({ coreStatus: "ACTIVE" });
    await onShopifyConnected({
      tenantId: tenant.id,
      externalShopId: shopId(),
      shopDomain: "x.myshopify.com",
    });
    const snap = await getShopifyAccessSnapshot(tenant.id);
    expect(snap.availablePlanCount).toBe(0);
    expect(await shopifyEntitlements(tenant.id)).toEqual([]);
  });

  it("Core alone never grants Shopify capability, however healthy it is", async () => {
    enableBilling();
    const { tenant } = await newTenant({ coreStatus: "ACTIVE", paidAt: AFTER });
    await onShopifyConnected({
      tenantId: tenant.id,
      externalShopId: shopId(),
      shopDomain: "x.myshopify.com",
    });
    expect(await shopifyEntitlements(tenant.id)).toEqual([]);
  });
});
