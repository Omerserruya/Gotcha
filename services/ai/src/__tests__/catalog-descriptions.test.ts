/**
 * ★ The business systems catalogue speaks the reader's language
 * (/studio/capabilities in Hebrew showed every description in English):
 *   - GET /api/integrations and GET /api/integrations/:slug answer
 *     `description` in Hebrew for a Hebrew reader (?locale, then a one-tag
 *     Accept-Language, then the user's language), in English otherwise
 *   - a slug with no Hebrew (a new catalogue row) keeps its English text
 *   - every catalogue slug has Hebrew, written by the house rules
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { on = vi.fn(); quit = vi.fn(); async get() { return null; } async set() { return "OK"; } } }));

const H = vi.hoisted(() => ({ userLocale: "en" }));
const row = (slug: string, description: string) => ({ id: `cat_${slug}`, slug, name: slug, description, longDescription: null, authType: "API_KEY", authSchema: null, catalogTools: [], tenantConnections: [] });
const ROWS = [row("shopify", "E-commerce platform for online stores"), row("newsys", "A system added after this map")];

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
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN", tenantId: "tenant_a" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "tenant_a"; n(); },
    requireOnboardingOrActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requirePermission: () => (_q: any, _s: any, n: any) => n(),
    requirePermissionOrRole: () => (_q: any, _s: any, n: any) => n(),
  };
});

import router from "../routes/integrations";
import { CATALOG_DESCRIPTION_HE } from "../lib/catalog-descriptions";

const app = express();
app.use(express.json());
app.use("/api/integrations", router);

const list = (headers: Record<string, string> = {}, q = "") => request(app).get(`/api/integrations${q}`).set(headers);
const descriptions = (r: request.Response) => Object.fromEntries(r.body.data.map((d: any) => [d.slug, d.description]));

beforeEach(() => { H.userLocale = "en"; });

describe("★ the catalogue in the reader's language", () => {
  it("a Hebrew reader (the v2 app's one-tag Accept-Language) gets Hebrew; a system with no Hebrew keeps its English", async () => {
    const r = await list({ "Accept-Language": "he" });
    expect(r.status).toBe(200);
    expect(descriptions(r)).toEqual({ shopify: "פלטפורמת מסחר מקוון לחנויות אונליין", newsys: "A system added after this map" });
  });

  it("an English reader gets the English text", async () => {
    expect(descriptions(await list({ "Accept-Language": "en" }))).toEqual({ shopify: "E-commerce platform for online stores", newsys: "A system added after this map" });
  });

  it("the order: ?locale, then a one-tag header, then the user's language (a browser's list says nothing)", async () => {
    H.userLocale = "he";
    expect(descriptions(await list({ "Accept-Language": "en-US,en;q=0.9" })).shopify).toBe(CATALOG_DESCRIPTION_HE.shopify);
    expect(descriptions(await list({ "Accept-Language": "he" }, "?locale=en")).shopify).toBe("E-commerce platform for online stores");
  });

  it("one system's page too", async () => {
    const r = await request(app).get("/api/integrations/shopify").set("Accept-Language", "he");
    expect(r.body.data).toMatchObject({ slug: "shopify", description: CATALOG_DESCRIPTION_HE.shopify });
    const en = await request(app).get("/api/integrations/shopify").set("Accept-Language", "en");
    expect(en.body.data.description).toBe("E-commerce platform for online stores");
  });
});

describe("the Hebrew itself", () => {
  // The catalogue on dev (integration_catalog, 2026-10-08), published or not.
  const SLUGS = ["shopify", "woocommerce", "fireberry", "stripe", "paypal", "hubspot", "salesforce", "zoho_crm", "monday", "google_calendar", "returngo", "calendly", "postgresql", "mongodb", "aws_rds", "custom_api", "airtable"];

  it("every catalogue system has it", () => {
    expect(Object.keys(CATALOG_DESCRIPTION_HE).sort()).toEqual([...SLUGS].sort());
    for (const [slug, he] of Object.entries(CATALOG_DESCRIPTION_HE)) expect(he, slug).toMatch(/[א-ת]/);
  });

  it("house rules: no wide dash; a Hebrew prefix joins a Hebrew word (a hyphen only before Latin or digits)", () => {
    for (const [slug, he] of Object.entries(CATALOG_DESCRIPTION_HE)) {
      expect(he, slug).not.toMatch(/[–—―]/);
      expect(he, slug).not.toMatch(/(^|[\s(])[מבלהושכ]-[א-ת]/);
    }
  });
});
