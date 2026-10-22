/**
 * ★ GET /api/integrations/business-core says its prose as codes too
 * (2026-10-08, the Hebrew sweep): catalogueNotes and each part's `reason`
 * were English sentences a screen could only show in English or match by
 * regex. Add-only: the sentences stay, beside them
 *   - catalogueNoteCodes, in the same order as catalogueNotes
 *   - each role's reasonCode and reasonParams, from the resolver
 */
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { on = vi.fn(); quit = vi.fn(); async get() { return null; } async set() { return "OK"; } } }));

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: {
      integrationCatalog: { findMany: async () => [{ slug: "shopify", name: "Shopify", category: "ecommerce", canActAsCrm: true }] },
      tenantIntegration: { findMany: async () => [{ status: "ERROR", config: {}, integration: { slug: "shopify", name: "Shopify" } }] },
    },
    readDurableSetting: async () => null,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN", tenantId: "T" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireOnboardingOrActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requirePermission: () => (_q: any, _s: any, n: any) => n(),
    requirePermissionOrRole: () => (_q: any, _s: any, n: any) => n(),
  };
});
vi.mock("../services/connectors/part-systems", () => ({
  getBusinessCoreMap: async () => [
    { part: "ecommerce", slug: "shopify", source: "elected", reason: "shopify was chosen for ecommerce.", reasonCode: "elected", reasonParams: { slug: "shopify" } },
    { part: "returns", slug: null, source: "unmapped", reason: "Nothing has been chosen for returns. shopify would be inferred, but its connection status is ERROR, so it does not serve this part.", reasonCode: "inference_not_working", reasonParams: { slug: "shopify", status: "ERROR" } },
    { part: "crm", slug: null, source: "unmapped", reason: "No customer system of record is configured.", reasonCode: "none_chosen" },
    { part: "payments", slug: null, source: "unmapped", reason: "No system has been chosen for payments.", reasonCode: "none_chosen" },
    { part: "shipping", slug: null, source: "unavailable", reason: "No shipping integration exists.", reasonCode: "no_integrations_exist" },
  ],
}));

import router from "../routes/integrations";

const app = express();
app.use(express.json());
app.use("/api/integrations", router);

describe("★ business-core: codes beside the prose", () => {
  it("the two catalogue notes, as codes in the same order; the sentences still there", async () => {
    const r = await request(app).get("/api/integrations/business-core");
    expect(r.status).toBe(200);
    expect(r.body.data.catalogueNoteCodes).toEqual(["shipping_category_empty", "returngo_listed_under_returns"]);
    expect(r.body.data.catalogueNotes).toHaveLength(2);
    expect(r.body.data.catalogueNotes[0]).toMatch(/shipping category/);
  });

  it("each role's reason as a code with what it names; the prose unchanged", async () => {
    const roles = (await request(app).get("/api/integrations/business-core")).body.data.roles;
    const byPart = Object.fromEntries(roles.map((r: any) => [r.role, r]));
    expect(byPart.ecommerce).toMatchObject({ reasonCode: "elected", reasonParams: { slug: "shopify" }, reason: "shopify was chosen for ecommerce." });
    expect(byPart.returns).toMatchObject({ reasonCode: "inference_not_working", reasonParams: { slug: "shopify", status: "ERROR" } });
    expect(byPart.crm).toMatchObject({ reasonCode: "none_chosen", reasonParams: {} });
    expect(byPart.shipping).toMatchObject({ reasonCode: "no_integrations_exist", unavailableReason: "no_integrations_exist" });
  });
});
