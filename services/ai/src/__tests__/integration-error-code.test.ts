/**
 * ★ A connection's error carries a machine code beside its sentence, with no
 * migration: the interface matched the free English by regex, so a reworded
 * sentence fell back silently to the generic line (2026-10-08).
 *   - a writer that knows why stores "[CODE] sentence" (lib/error-code)
 *   - GET /api/integrations serves { lastError: sentence, lastErrorCode }
 *   - a row written before the codes is recognised by its exact old sentence
 *   - any other error: its text, and no code
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { splitErrorCode, withErrorCode } from "../lib/error-code";

vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { on = vi.fn(); quit = vi.fn(); async get() { return null; } async set() { return "OK"; } } }));

const H = vi.hoisted(() => ({ lastError: null as string | null }));
vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  const row = () => ({ id: "cat_shopify", slug: "shopify", name: "Shopify", description: "x", longDescription: null, authType: "OAUTH2", authSchema: null, catalogTools: [],
    tenantConnections: [{ id: "ti1", status: "DISCONNECTED", lastError: H.lastError }] });
  return {
    ...actual,
    prisma: { integrationCatalog: { findMany: async () => [row()], findUnique: async () => row() } },
    resolveEffectiveLocale: async () => ({ effective: "en" }),
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
const served = async () => {
  const list = (await request(app).get("/api/integrations")).body.data[0].tenantConnection;
  const one = (await request(app).get("/api/integrations/shopify")).body.data.tenantConnection;
  expect(one).toEqual(list);
  return { lastError: list.lastError, lastErrorCode: list.lastErrorCode };
};

beforeEach(() => { H.lastError = null; });

describe("★ the error's code, served apart from its sentence", () => {
  it("a coded error: the sentence alone, and its code", async () => {
    H.lastError = withErrorCode("SHOPIFY_APP_UNINSTALLED");
    expect(await served()).toEqual({ lastError: "The GOTCHA Shopify app was uninstalled from this store.", lastErrorCode: "SHOPIFY_APP_UNINSTALLED" });
  });

  it("a row written before the codes: recognised by its exact old sentence", async () => {
    H.lastError = "The GOTCHA Shopify app was uninstalled from this store.";
    expect(await served()).toEqual({ lastError: "The GOTCHA Shopify app was uninstalled from this store.", lastErrorCode: "SHOPIFY_APP_UNINSTALLED" });
  });

  it("any other error: its text, bounded, and no code; none: nulls", async () => {
    H.lastError = `provider said: ${"x".repeat(400)}`;
    const other = await served();
    expect(other.lastErrorCode).toBeNull();
    expect(other.lastError).toHaveLength(200);
    // An HTML page is never served, even cut short (2026-10-11): it becomes a
    // sentence (lib/error-code markupError).
    H.lastError = `<!DOCTYPE html>${"x".repeat(400)}`;
    expect(await served()).toEqual({ lastError: "The system answered with an error page.", lastErrorCode: null });
    H.lastError = null;
    expect(await served()).toEqual({ lastError: null, lastErrorCode: null });
  });

  it("the split itself: only a well-formed [CODE] prefix is a code", () => {
    expect(splitErrorCode("[SHOPIFY_CHAT_UNINSTALLED] Shopify Chat app was uninstalled from the store.")).toEqual({ lastError: "Shopify Chat app was uninstalled from the store.", lastErrorCode: "SHOPIFY_CHAT_UNINSTALLED" });
    expect(splitErrorCode("[note] something")).toEqual({ lastError: "[note] something", lastErrorCode: null });
    expect(splitErrorCode("Shopify Chat app was uninstalled from the store. Again.")).toEqual({ lastError: "Shopify Chat app was uninstalled from the store. Again.", lastErrorCode: null });
  });
});
