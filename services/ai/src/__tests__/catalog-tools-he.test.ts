/**
 * ★ The catalogue's actions speak the reader's language (2026-10-08):
 * /studio/capabilities listed "Get customer", "Create coupon" in English for
 * a Hebrew reader.
 *   - GET /api/integrations and GET /api/integrations/:slug answer each
 *     catalogTools[].name / description in Hebrew for a Hebrew reader, in
 *     English otherwise; an action with no Hebrew keeps its English
 *   - every Hebrew string keeps the house rules (the sweep)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { CATALOG_TOOL_HE, catalogTool } from "../lib/catalog-tools-he";
import { hebrewHouseRuleViolations } from "./helpers/hebrew-house-rules";

vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { on = vi.fn(); quit = vi.fn(); async get() { return null; } async set() { return "OK"; } } }));

const H = vi.hoisted(() => ({ userLocale: "en" }));
const tool = (slug: string, name: string, description: string) => ({ id: `t_${slug}`, slug, name, description, tenantTools: [] });
const ROWS = [{
  id: "cat_shopify", slug: "shopify", name: "Shopify", description: "E-commerce platform for online stores", longDescription: null, authType: "OAUTH2", authSchema: null,
  catalogTools: [tool("create_one_time_coupon", "Create One-Time Coupon", "Create a single-use coupon code."), tool("brand_new_tool", "Brand New Tool", "Added after the map.")],
  tenantConnections: [],
}];

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: {
      integrationCatalog: {
        findMany: async () => ROWS,
        findUnique: async (a: any) => ROWS.find((r) => r.slug === a.where.slug) ?? null,
      },
    },
    resolveEffectiveLocale: async () => ({ effective: H.userLocale }),
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN", tenantId: "T" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requireOnboardingOrActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requirePermission: () => (_q: any, _s: any, n: any) => n(),
    requirePermissionOrRole: () => (_q: any, _s: any, n: any) => n(),
  };
});

import router from "../routes/integrations";

const app = express();
app.use(express.json());
app.use("/api/integrations", router);
const toolsOf = (body: any) => Object.fromEntries((Array.isArray(body.data) ? body.data[0] : body.data).catalogTools.map((t: any) => [t.slug, { name: t.name, description: t.description }]));

beforeEach(() => { H.userLocale = "en"; });

describe("★ the catalogue's actions in the reader's language", () => {
  it("the list and one system's page: Hebrew for a Hebrew reader; an action with no Hebrew keeps its English", async () => {
    for (const path of ["/api/integrations", "/api/integrations/shopify"]) {
      const he = toolsOf((await request(app).get(path).set("Accept-Language", "he")).body);
      expect(he.create_one_time_coupon).toEqual({ name: "יצירת קופון חד פעמי", description: "יצירת קוד קופון לשימוש יחיד." });
      expect(he.brand_new_tool).toEqual({ name: "Brand New Tool", description: "Added after the map." });
    }
  });

  it("English for an English reader, as stored", async () => {
    const en = toolsOf((await request(app).get("/api/integrations").set("Accept-Language", "en")).body);
    expect(en.create_one_time_coupon).toEqual({ name: "Create One-Time Coupon", description: "Create a single-use coupon code." });
  });

  it("the reader's own language when the request names none", async () => {
    H.userLocale = "he";
    const he = toolsOf((await request(app).get("/api/integrations")).body);
    expect(he.create_one_time_coupon.name).toBe("יצירת קופון חד פעמי");
  });

  it("the key is the integration and the tool: the same tool slug under another system is not translated", () => {
    expect(catalogTool("woocommerce", { slug: "create_one_time_coupon", name: "X", description: "Y" }, "he")).toEqual({ slug: "create_one_time_coupon", name: "X", description: "Y" });
  });
});

describe("★ the Hebrew itself keeps the house rules", () => {
  it("every one of the catalogue's actions, name and description", () => {
    const entries = Object.entries(CATALOG_TOOL_HE);
    expect(entries.length).toBe(153);
    const violations = entries.flatMap(([k, v]) => [...hebrewHouseRuleViolations(`${k} name`, v.name), ...hebrewHouseRuleViolations(`${k} description`, v.description)]);
    expect(violations).toEqual([]);
  });

  it("the sweep itself catches what it is for", () => {
    expect(hebrewHouseRuleViolations("t", "יצירת קופון — חדש")).toHaveLength(1);
    expect(hebrewHouseRuleViolations("t", "שליחה ב-חנות")).toHaveLength(1);
    expect(hebrewHouseRuleViolations("t", "שליחה בShopify")).toHaveLength(1);
    expect(hebrewHouseRuleViolations("t", "GOTCHA יוצר קופון")).toHaveLength(1);
    expect(hebrewHouseRuleViolations("t", "אני בודק את ההזמנה")).toHaveLength(1);
    expect(hebrewHouseRuleViolations("t", "ראה שיחות קודמות")).toHaveLength(1);
    expect(hebrewHouseRuleViolations("t", "GOTCHA יוצרת קופון ב-Shopify לשימוש יחיד.")).toEqual([]);
  });
});
