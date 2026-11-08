/**
 * PUT /api/integrations/woocommerce/catalog-config (Smoovee 2026-11-08): the
 * categories customers may be shown, and the store's language. Only those two
 * keys of the connection's config change; storeUrl and the rest stay.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.CHANNEL_ENCRYPTION_KEY = "248b2b86ff1b58bb208e102890ba28f2dd0c5c7dbc45fb81ae3d28531044ef37";
});
vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { on = vi.fn(); quit = vi.fn(); async get() { return null; } async set() { return "OK"; } } }));

const DB = vi.hoisted(() => ({ integration: null as any }));
vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: {
      integrationCatalog: { findUnique: async (a: any) => (a.where.slug === "woocommerce" ? { id: "cat_woo" } : null) },
      tenantIntegration: {
        findFirst: async (a: any) => (DB.integration && DB.integration.tenantId === a.where.tenantId && DB.integration.integrationId === a.where.integrationId ? { ...DB.integration } : null),
        update: async (a: any) => { Object.assign(DB.integration, a.data); return { ...DB.integration }; },
      },
    },
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "tenant_a"; n(); },
    requireOnboardingOrActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requirePermission: () => (_q: any, _s: any, n: any) => n(),
    requirePermissionOrRole: () => (_q: any, _s: any, n: any) => n(),
  };
});

import router from "../routes/integrations";
import { categoryAllowList, productLanguage } from "../services/connectors/woocommerce.adapter";

const app = express();
app.use(express.json());
app.use("/api/integrations", router);
const put = (body: any, slug = "woocommerce") => request(app).put(`/api/integrations/${slug}/catalog-config`).send(body);

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  DB.integration = { id: "ti_1", tenantId: "tenant_a", integrationId: "cat_woo", config: { storeUrl: "https://smoovee-ltd.com" } };
});

describe("catalog-config", () => {
  it("sets both, keeps storeUrl, and the adapter reads them", async () => {
    const r = await put({ productCategoryIds: ["86", "87", "86"], storeLanguage: "he" });
    expect(r.status).toBe(200);
    expect(DB.integration.config).toEqual({ storeUrl: "https://smoovee-ltd.com", productCategoryIds: ["86", "87"], storeLanguage: "he" });
    expect([...categoryAllowList(DB.integration.config)!]).toEqual(["86", "87"]);
    expect(productLanguage({}, DB.integration.config)).toBe("he");
  });
  it("null or [] clears a field; a field left out is kept", async () => {
    await put({ productCategoryIds: ["86"], storeLanguage: "he" });
    await put({ productCategoryIds: [] });
    expect(DB.integration.config).toEqual({ storeUrl: "https://smoovee-ltd.com", storeLanguage: "he" });
    await put({ storeLanguage: null });
    expect(DB.integration.config).toEqual({ storeUrl: "https://smoovee-ltd.com" });
    expect(categoryAllowList(DB.integration.config)).toBeNull();
  });
  it("refuses what is not ids or a language, another system, nothing to change, no connection", async () => {
    expect((await put({ productCategoryIds: ["86", "shop"] })).status).toBe(400);
    expect((await put({ productCategoryIds: "86" })).status).toBe(400);
    expect((await put({ storeLanguage: "fr" })).status).toBe(400);
    expect((await put({ productCategoryIds: ["86"] }, "shopify")).status).toBe(400);
    expect((await put({})).status).toBe(400);
    DB.integration.tenantId = "tenant_b";
    expect((await put({ productCategoryIds: ["86"] })).status).toBe(404);
  });
});
