/**
 * ★ Where the hosted card page sends the person back (2026-10-08, design 17):
 * the session built its return URL on the OLD app, which then ran confirm
 * itself, so v2 never saw the card it asked for.
 *   - returnTo "v2": <this origin>/v2/settings/billing/payment-method, and the
 *     same path with ?cancelled=1 for cancel and failure; no locale, no
 *     session id, no token in any of them
 *   - absent: exactly the old behaviour
 *   - anything else (an unknown token, a URL, "//host", another type): 400,
 *     refused before anything is created or sent
 *   - a misconfigured base path never yields an off-origin URL
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ sessions: [] as any[], created: 0 }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const nothing: any = new Proxy({}, { get: () => new Proxy({}, { get: () => async () => null }) });
  return {
    ...actual,
    prisma: nothing,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "owner", email: "o@x.test" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
    requirePermission: () => (_q: any, _s: any, n: any) => n(),
  };
});
vi.mock("../services/billable-entity.service", () => ({ ensureBillableEntity: async () => { H.created++; return "ent1"; } }));
vi.mock("../services/tokenization.service", () => ({
  startTokenizationSession: async (input: any) => { H.sessions.push(input); return { session: { id: "tks_1" }, saleUrl: "https://provider.example/pay/abc" }; },
  verifyTokenizationSession: async () => ({}),
  TokenizationRefused: class extends Error {},
}));
vi.mock("../providers/capabilities", async (importOriginal) => ({ ...(await importOriginal<any>()), checkoutEnabled: () => true }));
vi.mock("../services/subscription.service", () => ({ contractedPrice: () => 0 }));

import router from "../routes/payment-methods";

const app = express();
app.use(express.json());
app.use(router);
const start = (body: any) => request(app).post("/billing/payment-methods/session").send(body);

const ENV = { ...process.env };
beforeEach(() => {
  H.sessions = []; H.created = 0;
  process.env.APP_PUBLIC_URL = "https://dev.gotcha.co.il";
  delete process.env.V2_BASE_PATH;
});
afterEach(() => { process.env = { ...ENV }; });

describe("★ the card page returns to the app that asked", () => {
  it("v2: the v2 page on this origin; cancel and failure with ?cancelled=1; no locale, no session id", async () => {
    const r = await start({ returnTo: "v2" });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ redirectUrl: "https://provider.example/pay/abc", sessionId: "tks_1" });
    expect(H.sessions[0]).toMatchObject({
      successUrl: "https://dev.gotcha.co.il/v2/settings/billing/payment-method",
      failureUrl: "https://dev.gotcha.co.il/v2/settings/billing/payment-method?cancelled=1",
      cancelUrl: "https://dev.gotcha.co.il/v2/settings/billing/payment-method?cancelled=1",
    });
    const urls = [H.sessions[0].successUrl, H.sessions[0].failureUrl, H.sessions[0].cancelUrl].join(" ");
    expect(urls).not.toMatch(/tks_1|token|session|\/(he|en)\//);
  });

  it("absent: exactly the old behaviour (the old app's page, no cancel or failure URL)", async () => {
    await start({});
    expect(H.sessions[0].successUrl).toBe("https://dev.gotcha.co.il/settings/billing/payment-method");
    expect(H.sessions[0].failureUrl).toBeUndefined();
    expect(H.sessions[0].cancelUrl).toBeUndefined();
  });

  it.each([
    ["an unknown token", "v3"],
    ["a different case", "V2"],
    ["a full URL", "https://evil.example/steal"],
    ["a protocol-relative URL", "//evil.example"],
    ["a path", "/v2/settings"],
    ["a prototype key", "constructor"],
    ["a number", 2],
    ["an object", { v2: true }],
  ])("%s: 400 invalid_return_target, nothing created or sent", async (_n, returnTo) => {
    const r = await start({ returnTo });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "invalid_return_target" });
    expect(H.sessions).toEqual([]);
    expect(H.created).toBe(0);
  });

  it("a base path set to a URL is refused as configuration: no off-origin return, the page still opens", async () => {
    process.env.V2_BASE_PATH = "https://evil.example";
    const r = await start({ returnTo: "v2" });
    expect(r.status).toBe(200);
    expect(H.sessions[0].successUrl).toBeUndefined();
    expect(H.sessions[0].cancelUrl).toBeUndefined();
    // Same origin but not a plain path: a query or a climb out of it is refused too.
    for (const bad of ["/v2?next=", "/v2/../admin"]) {
      process.env.V2_BASE_PATH = bad;
      H.sessions = [];
      await start({ returnTo: "v2" });
      expect(H.sessions[0].successUrl).toBeUndefined();
    }
    H.sessions = [];
    process.env.V2_BASE_PATH = "/app";
    await start({ returnTo: "v2" });
    expect(H.sessions[0].successUrl).toBe("https://dev.gotcha.co.il/app/settings/billing/payment-method");
  });
});
