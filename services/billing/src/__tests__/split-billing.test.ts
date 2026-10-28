/**
 * Split billing (2026-10-28, Shopify review 132211 under 1.2.1).
 *
 *   GOTCHA Core is billed by GOTCHA and never grants Shopify; the Shopify
 *   Connector is billed only through Shopify App Pricing. Every Core billing
 *   response says scope "gotcha_core" / billedBy "gotcha"; the Connector's one
 *   verdict says "shopify_connector" / "shopify". The legacy plan-change route
 *   is retired, and a missing card is refused before any charge.
 *
 * Mocked throughout: no billing writes on dev (dev billing is prod iCount).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FOUR = ["shopify_catalog_sync", "shopify_order_read", "shopify_order_actions", "shopify_storefront_widget"];

vi.hoisted(() => {
  process.env.SHOPIFY_BILLING_ENABLED = "true";
  process.env.SHOPIFY_APP_HANDLE = "gotcha";
  process.env.SHOPIFY_BILLING_PLAN_CATALOG = JSON.stringify([
    { key: "SHOPIFY_CONNECTOR", handle: "connector", interval: "monthly", entitlements: ["shopify_catalog_sync", "shopify_order_read", "shopify_order_actions", "shopify_storefront_widget"] },
  ]);
});

const DB = vi.hoisted(() => ({
  link: { billableEntityId: "be1" } as any,
  connection: null as any,
  grant: null as any,
  integration: null as any,
  core: null as any,
  providerSub: null as any,
  entitlements: [] as string[],
  coreConnect: { allowed: true, reason: null as string | null },
  audits: [] as any[],
  changePlanError: null as any,
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, any>;
  return {
    ...actual,
    authenticate: (req: any, _res: any, next: any) => { req.user = { userId: "u1", role: "ADMIN" }; next(); },
    resolveTenant: (req: any, _res: any, next: any) => { req.tenantId = "t1"; next(); },
    requirePermission: () => (_q: any, _s: any, n: any) => n(),
    coreAllowsShopifyConnect: async () => ({ ...DB.coreConnect, httpStatus: DB.coreConnect.allowed ? 200 : 402, body: null, tenantStatus: "ACTIVE" }),
    prisma: {
      billableEntityTenant: { findUnique: async () => DB.link },
      commerceConnection: { findFirst: async () => DB.connection },
      shopifyGrandfatherGrant: { findUnique: async () => DB.grant },
      tenantIntegration: { findFirst: async () => DB.integration },
      subscription: { findUnique: async () => DB.core },
      providerSubscription: { findUnique: async () => DB.providerSub },
      tenantEntitlement: { findMany: async () => DB.entitlements.map((entitlementKey) => ({ entitlementKey })) },
      auditLog: { create: async (a: any) => { DB.audits.push(a.data); return a.data; } },
    },
  };
});
vi.mock("../services/subscription.service", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    changePlan: vi.fn(async () => { if (DB.changePlanError) throw DB.changePlanError; return { applied: "immediate" }; }),
    previewPlanChange: vi.fn(async () => ({ applied: "immediate", paymentMethodRequired: true, hasPaymentMethod: false })),
  };
});

import { getShopifyAccessSnapshot, serializeSnapshot } from "../services/shopify-billing-state.service";
import { recordProviderSubscriptionChange } from "../services/provider-subscription.service";
import { PaymentMethodRequired } from "../services/subscription.service";
import { coreScope, CORE_BILLING_PATHS, withCoreScope } from "../lib/core-scope";
import pricingRoutes from "../routes/pricing";
import subscriptionRoutes from "../routes/subscription";

const CONNECTED = { id: "cc1", status: "CONNECTED", shopDomain: "acme.myshopify.com", externalShopId: "1", installedAt: new Date("2026-10-01"), uninstalledAt: null };
const ACTIVE_SUB = { status: "ACTIVE", providerSubscriptionId: "gid://sub/1", providerPlanHandle: "connector", planKey: "SHOPIFY_CONNECTOR", providerStatusRaw: "ACTIVE", lastVerifiedAt: new Date() };
const state = async () => serializeSnapshot(await getShopifyAccessSnapshot("t1"));

beforeEach(() => {
  Object.assign(DB, {
    link: { billableEntityId: "be1" }, connection: null, grant: null, integration: null,
    core: { status: "ACTIVE", planKey: "call_pilot", billingSource: "ICOUNT" },
    providerSub: null, entitlements: [], coreConnect: { allowed: true, reason: null }, audits: [], changePlanError: null,
  });
});

describe("GET /api/billing/shopify/state is the one verdict", () => {
  it("Core without the Connector: the most expensive Core plan grants nothing on Shopify", async () => {
    const s = await state();
    expect(s.core).toMatchObject({ planKey: "call_pilot", subscriptionStatus: "ACTIVE", scope: "gotcha_core", billedBy: "gotcha", allowsShopifyConnect: true, connectBlockedReason: null });
    expect(s).toMatchObject({ scope: "shopify_connector", billedBy: "shopify", grantsAccess: false });
    expect(Object.values(s.capabilities).every((x) => x === false)).toBe(true);
    expect(s.connector).toEqual({ status: "not_installed", uninstallRequestedAt: null, manageUrl: null });
  });

  it("OAuth without the Connector is authorized, never active", async () => {
    DB.connection = { ...CONNECTED, status: "BILLING_PENDING" };
    const s = await state();
    expect(s.connector.status).toBe("authorized_not_active");
    expect(s.grantsAccess).toBe(false);
    expect(s.requiresPlanSelection).toBe(true);
    expect(s.planSelectionUrl).toBe("https://admin.shopify.com/store/acme/charges/gotcha/pricing_plans");
  });

  it("the Connector with Core: active, every capability, and where to manage it", async () => {
    DB.connection = CONNECTED; DB.providerSub = ACTIVE_SUB; DB.entitlements = FOUR;
    const s = await state();
    expect(s).toMatchObject({ grantsAccess: true, requiredEntitlements: FOUR });
    expect(Object.values(s.capabilities).every(Boolean)).toBe(true);
    expect(s.connector).toEqual({ status: "active", uninstallRequestedAt: null, manageUrl: "https://admin.shopify.com/store/acme/charges/gotcha/pricing_plans" });
  });

  it("ACTIVE with one entitlement row: only that capability, and no access", async () => {
    DB.connection = CONNECTED; DB.providerSub = ACTIVE_SUB; DB.entitlements = ["shopify_order_read"];
    const s = await state();
    expect(s.grantsAccess).toBe(false);
    expect(s.capabilities).toEqual({ shopify_catalog_sync: false, shopify_order_read: true, shopify_order_actions: false, shopify_storefront_widget: false });
    expect(s.connector.status).toBe("error");
  });

  it("an uninstall in flight survives a reload", async () => {
    DB.connection = CONNECTED; DB.providerSub = ACTIVE_SUB; DB.entitlements = FOUR;
    DB.integration = { config: { uninstallRequestedAt: "2026-10-28T11:00:00.000Z" } };
    const s = await state();
    expect(s.connector).toMatchObject({ status: "uninstall_pending", uninstallRequestedAt: "2026-10-28T11:00:00.000Z" });
  });

  it("uninstalled with a historical ACTIVE subscription: no access", async () => {
    DB.connection = { ...CONNECTED, status: "DISCONNECTED", uninstalledAt: new Date() };
    DB.providerSub = ACTIVE_SUB; DB.entitlements = FOUR;
    const s = await state();
    expect([s.grantsAccess, s.connector.status, s.connector.manageUrl]).toEqual([false, "uninstalled", null]);
  });

  it("UNKNOWN_PLAN requires nothing it can name, so it never grants", async () => {
    DB.connection = CONNECTED; DB.providerSub = { ...ACTIVE_SUB, providerPlanHandle: "mystery" }; DB.entitlements = FOUR;
    const s = await state();
    expect(s.shopify.state).toBe("UNKNOWN_PLAN");
    expect([s.grantsAccess, s.requiredEntitlements, s.connector.status]).toEqual([false, [], "error"]);
  });

  it("Core not paid: the claim's own answer, so the screen never invents it", async () => {
    DB.coreConnect = { allowed: false, reason: "TENANT_PAYMENT_REQUIRED" };
    const s = await state();
    expect(s.core).toMatchObject({ allowsShopifyConnect: false, connectBlockedReason: "TENANT_PAYMENT_REQUIRED" });
  });

  it("no existing field changed name: the main-branch keys are all still there", async () => {
    const s = await state();
    for (const k of ["core", "installation", "shopify", "grandfathered", "entitlements", "planSelectionUrl", "availablePlanCount", "requiresPlanSelection", "grantsAccess"]) {
      expect(s).toHaveProperty(k);
    }
  });
});

describe("Core billing responses say they are Core", () => {
  const app = express();
  app.use(CORE_BILLING_PATHS, coreScope);
  app.get("/api/billing/subscription", (_q, r) => { r.json({ subscription: { planKey: "call_pilot" } }); });
  app.get("/api/billing/invoices", (_q, r) => { r.json([{ id: "i1" }]); });
  app.get("/api/billing/pricing", (_q, r) => { r.json({ scope: "something_else", x: 1 }); });
  app.get("/api/billing/shopify/state", (_q, r) => { r.json({ grantsAccess: false }); });

  it("a plain object gains exactly scope and billedBy, nothing else changes", async () => {
    const body = (await request(app).get("/api/billing/subscription")).body;
    expect(body).toEqual({ subscription: { planKey: "call_pilot" }, scope: "gotcha_core", billedBy: "gotcha" });
  });
  it("an array is sent as it was; an existing scope is never overwritten", async () => {
    expect((await request(app).get("/api/billing/invoices")).body).toEqual([{ id: "i1" }]);
    expect((await request(app).get("/api/billing/pricing")).body).toEqual({ scope: "something_else", x: 1 });
  });
  it("Shopify's billing and the Core checkout are not Core-scoped", async () => {
    expect((await request(app).get("/api/billing/shopify/state")).body).toEqual({ grantsAccess: false });
    expect(CORE_BILLING_PATHS.some((p) => p.startsWith("/api/checkout"))).toBe(false);
    expect(CORE_BILLING_PATHS.some((p) => p.includes("shopify"))).toBe(false);
  });
  it("withCoreScope leaves non-objects alone", () => {
    expect(withCoreScope(null)).toBeNull();
    expect(withCoreScope("x")).toBe("x");
  });
  it("mounted before every Core router", () => {
    const index = readFileSync(join(__dirname, "../index.ts"), "utf8");
    expect(index.indexOf("app.use(CORE_BILLING_PATHS, coreScope);")).toBeGreaterThan(-1);
    expect(index.indexOf("app.use(CORE_BILLING_PATHS, coreScope);")).toBeLessThan(index.indexOf('app.use("/api", subscriptionRoutes);'));
  });
});

describe("Core plan changes", () => {
  const app = express();
  app.use(express.json());
  app.use(CORE_BILLING_PATHS, coreScope);
  app.use("/api", pricingRoutes);
  app.use("/api", subscriptionRoutes);

  it("the legacy POST /api/billing/pricing/change is retired with a reason", async () => {
    const r = await request(app).post("/api/billing/pricing/change").send({ planKey: "call_pilot" });
    expect(r.status).toBe(410);
    expect(r.body).toMatchObject({ error: "endpoint_retired", use: "/api/billing/subscription/change-plan", scope: "gotcha_core", billedBy: "gotcha" });
  });

  it("no card: 402 payment_method_required, scoped to Core", async () => {
    DB.changePlanError = new PaymentMethodRequired();
    const r = await request(app).post("/api/billing/subscription/change-plan").send({ planKey: "call_pilot" });
    expect(r.status).toBe(402);
    expect(r.body).toEqual({ error: "payment_method_required", scope: "gotcha_core", billedBy: "gotcha" });
  });

  it("the preview says so before the customer confirms", async () => {
    const r = await request(app).post("/api/billing/subscription/change-plan/preview").send({ planKey: "call_pilot" });
    expect(r.body.preview.paymentMethodRequired).toBe(true);
  });

  it("refused BEFORE any charge: the no-card check precedes chargeFor in changePlan", () => {
    const src = readFileSync(join(__dirname, "../services/subscription.service.ts"), "utf8");
    const body = src.slice(src.indexOf("export async function changePlan("));
    expect(body.indexOf("throw new PaymentMethodRequired()")).toBeGreaterThan(-1);
    expect(body.indexOf("throw new PaymentMethodRequired()")).toBeLessThan(body.indexOf("await chargeFor({"));
    expect(body).not.toContain('"nocard"');
  });

  it("a Core change touches zero Shopify entitlement rows", () => {
    // The Core write path: subscription.service and the materialiser it calls.
    const sub = readFileSync(join(__dirname, "../services/subscription.service.ts"), "utf8");
    expect(sub).not.toMatch(/tenantEntitlement\.(create|update|upsert|delete)/);
    const mat = readFileSync(join(__dirname, "../../../../packages/shared/src/lib/billing/entitlements.ts"), "utf8");
    const from = mat.indexOf("export async function materializeEntitlements(");
    const fn = mat.slice(from, mat.indexOf("\n}\n", from));
    expect(fn).toContain("tenantFeature.upsert");
    expect(fn).not.toMatch(/tenantEntitlement\.(create|update|upsert|delete)/);
  });
});

describe("the Connector's history is append-only", () => {
  it("one audit row per change, scoped to the Connector", async () => {
    await recordProviderSubscriptionChange({
      tenantId: "t1", providerSubscriptionRowId: "ps1", productKey: "shopify_connector", verifiedAt: new Date("2026-10-28T12:00:00Z"),
      from: { status: "TRIALING", planHandle: "connector", subscriptionId: "gid://sub/1" },
      to: { status: "ACTIVE", planHandle: "connector", subscriptionId: "gid://sub/1", rawStatus: "ACTIVE" },
    });
    expect(DB.audits).toEqual([expect.objectContaining({
      tenantId: "t1", action: "billing.provider_subscription.changed", targetType: "provider_subscription", targetId: "ps1",
      metadata: expect.objectContaining({ scope: "shopify_connector", billedBy: "shopify", from: expect.objectContaining({ status: "TRIALING" }), to: expect.objectContaining({ status: "ACTIVE" }) }),
    })]);
  });
  it("written by the sync on a change and by the uninstall", () => {
    const src = readFileSync(join(__dirname, "../services/provider-subscription.service.ts"), "utf8");
    expect(src.match(/await recordProviderSubscriptionChange\(/g)?.length).toBe(2);
  });
});
