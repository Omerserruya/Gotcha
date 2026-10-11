/**
 * A stored lastError that is a provider's HTML page is never served.
 *
 * Dev's Shopify row (2026-10-11) held Shopify's whole 401 page, written before
 * the refresh failure was cleaned at write time. Reads now serve the cause's
 * sentence and code instead. Through the real GET /connectors/:slug/status,
 * with the row's exact text.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.FRONTEND_URL = "https://app.gotcha.co.il";
  process.env.OAUTH_STATE_SECRET = "oauth-state-secret-for-tests-only-32chars";
  process.env.CHANNEL_ENCRYPTION_KEY = "a".repeat(64);
});
vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { publish = vi.fn(); on = vi.fn(); subscribe = vi.fn(); quit = vi.fn(); async set() { return "OK"; } } }));
vi.mock("@prisma/client", () => ({ PrismaClient: class { $extends() { return this; } } }));

const DB = vi.hoisted(() => ({ row: null as any }));
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, any>;
  return {
    ...actual,
    prisma: { tenantIntegration: { findUnique: async () => DB.row } },
    authenticate: (req: any, _res: any, next: any) => { req.user = { userId: "user-1", role: "ADMIN" }; next(); },
    resolveTenant: (req: any, _res: any, next: any) => { req.tenantId = "tenant-A"; next(); },
    requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requireOnboardingOrActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requirePermission: () => (_q: any, _s: any, n: any) => n(),
  };
});
vi.mock("../services/connector-connection.service", () => ({
  findCatalog: vi.fn(async (slug: string) => ({ id: `cat_${slug}`, slug })),
  upsertConnection: vi.fn(),
}));

import router from "../routes/connectors-admin";
import { splitErrorCode } from "../lib/error-code";

const app = express();
app.use(express.json());
app.use("/api", router);

const DEV_ROW_ERROR = "token_refresh_failed:shopify_token_refresh_failed_401: <!DOCTYPE html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\">\n  <title>unauthorized - Oauth error invalid_request</title>";

beforeEach(() => { DB.row = null; });

describe("GET /connectors/:slug/status never serves a stored HTML page", () => {
  it("dev's Shopify row: the cause's sentence and code, no markup", async () => {
    DB.row = { status: "ERROR", connectedAt: null, lastTestedAt: new Date(), lastError: DEV_ROW_ERROR, config: {} };

    const res = await request(app).get("/api/connectors/shopify/status");

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: "ERROR",
      lastError: "The system rejected these credentials.",
      lastErrorCode: "CREDENTIALS_INVALID",
    });
    expect(JSON.stringify(res.body)).not.toMatch(/DOCTYPE|<html|<title|Oauth error/);
  });

  it("a coded error is split the same way as the integrations list", async () => {
    DB.row = { status: "ERROR", lastError: "[CONNECTION_FAILED] The system could not be reached.", config: {} };
    const res = await request(app).get("/api/connectors/shopify/status");
    expect(res.body.data).toMatchObject({ lastError: "The system could not be reached.", lastErrorCode: "CONNECTION_FAILED" });
  });

  it("plain provider text that is not markup is still served as the platform said it", async () => {
    DB.row = { status: "ERROR", lastError: "monday_validation_failed: token accepted", config: {} };
    const res = await request(app).get("/api/connectors/monday/status");
    expect(res.body.data).toMatchObject({ lastError: "monday_validation_failed: token accepted", lastErrorCode: null });
  });
});

describe("splitErrorCode on markup", () => {
  it("maps a page by its cause, or to a neutral sentence", () => {
    expect(splitErrorCode("zoho_refresh_503: <html><body>down</body></html>")).toEqual({ lastError: "The system could not be reached.", lastErrorCode: "CONNECTION_FAILED" });
    expect(splitErrorCode("token_refresh_failed:<!DOCTYPE html><p>oops</p>")).toEqual({ lastError: "The connection's sign-in could not be renewed.", lastErrorCode: "TOKEN_REFRESH_FAILED" });
    expect(splitErrorCode("<html><body>something</body></html>")).toEqual({ lastError: "The system answered with an error page.", lastErrorCode: null });
  });
});
