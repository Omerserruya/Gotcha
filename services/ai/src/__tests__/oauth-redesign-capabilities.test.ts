/**
 * flow=redesign_studio on Zoho, Google Calendar and Calendly (and the shared
 * landing helper). Each lands on {origin}/studio/capabilities?system=<slug>
 * &connected=1 or &error=<closed code>, and every other flow keeps its exact
 * old answer. Real state signing and single-use consume; providers stubbed at
 * fetch; the DB is a permissive double (the subject is the landing, not the
 * row - the rows each route writes have their own suites).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.FRONTEND_URL = "https://app.example.test";
  process.env.OAUTH_STATE_SECRET = "oauth-state-secret-for-tests-only-32chars";
  process.env.CHANNEL_ENCRYPTION_KEY = "248b2b86ff1b58bb208e102890ba28f2dd0c5c7dbc45fb81ae3d28531044ef37";
  process.env.GOOGLE_CLIENT_ID = "g";
  process.env.GOOGLE_CLIENT_SECRET = "gs";
  process.env.GOOGLE_CALENDAR_REDIRECT_URI = "https://app.example.test/api/integrations/oauth/google_calendar/callback";
  process.env.CALENDLY_CLIENT_ID = "c";
  process.env.CALENDLY_CLIENT_SECRET = "cs";
  process.env.CALENDLY_REDIRECT_URI = "https://app.example.test/api/integrations/oauth/calendly/callback";
  process.env.ZOHO_CLIENT_ID = "z";
  process.env.ZOHO_CLIENT_SECRET = "zs";
  process.env.ZOHO_REDIRECT_URI = "https://app.example.test/api/integrations/oauth/zoho_crm/callback";
});

const R = vi.hoisted(() => ({ used: new Set<string>() }));
vi.mock("ioredis", () => ({
  default: class {
    on = vi.fn(); quit = vi.fn(); publish = vi.fn(); subscribe = vi.fn();
    async set(key: string, _v: string, ...rest: unknown[]) {
      if (rest.includes("NX") && R.used.has(key)) return null;
      R.used.add(key);
      return "OK";
    }
    async get() { return null; }
  },
}));
vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));

/** Any model, any method: resolves to a plausible row. */
const anyModel = () =>
  new Proxy({}, { get: (_t, m) => async () => (String(m).startsWith("findMany") ? [] : String(m) === "count" ? 0 : { id: "row_1", slug: "zoho_crm", catalogTools: [] }) });
vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: new Proxy({}, { get: () => anyModel() }),
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "user_1", role: "ADMIN" }; req.userId = "user_1"; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "tenant_a"; n(); },
    requireOnboardingOrActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requireRole: () => (_q: any, _s: any, n: any) => n(),
    // 2026-10-09: init gates on the connect permission (pinned in connect-oauth-permissions.test.ts).
    requirePermission: () => (_q: any, _s: any, n: any) => n(),
    reportOperationalFailure: () => undefined,
  };
});

import crmRouter from "../routes/crm-oauth";
import calendarRouter from "../routes/calendar-oauth";
import { mintOAuthState } from "@chatcenter/shared";
import { redesignCapabilitiesUrl, parseConnectFlow } from "../services/redesign-return";

const app = express();
app.use(express.json());
app.use("/api/integrations", crmRouter);
app.use("/api/integrations", calendarRouter);

const V2 = "https://app.example.test/studio/capabilities";
const ok = (body: any) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const bad = { ok: false, status: 400, json: async () => ({}), text: async () => "nope <script>" };
const flowOf = (url: string) =>
  JSON.parse(Buffer.from(new URL(url).searchParams.get("state")!.split(".")[1], "base64url").toString()).flow;

beforeEach(() => { R.used.clear(); vi.unstubAllGlobals(); });

const CASES = [
  { name: "Google Calendar", init: "/api/integrations/oauth/google_calendar/init", cb: "/api/integrations/oauth/google_calendar/callback", provider: "google", system: "google_calendar", extra: { aiAgentId: "row_1" } },
  { name: "Calendly", init: "/api/integrations/oauth/calendly/init", cb: "/api/integrations/oauth/calendly/callback", provider: "calendly", system: "calendly", extra: { aiAgentId: "row_1" } },
  { name: "Zoho", init: "/api/integrations/oauth/zoho_crm/init", cb: "/api/integrations/oauth/zoho_crm/callback", provider: "zoho_crm", system: "zoho_crm", extra: { integrationSlug: "zoho_crm" } },
] as const;

const st = (c: (typeof CASES)[number], flow?: string) =>
  mintOAuthState({ tenantId: "tenant_a", provider: c.provider, userId: "user_1", flow, ...c.extra } as any).state;

describe.each(CASES)("$name", (c) => {
  it("init carries redesign_studio and drops anything else", async () => {
    const good = await request(app).get(c.init).query({ flow: "redesign_studio" });
    expect(flowOf(good.body.url)).toBe("redesign_studio");
    const evil = await request(app).get(c.init).query({ flow: "https://evil.example" });
    expect(flowOf(evil.body.url)).toBeUndefined();
  });

  it("★ Cancel at the provider → error=denied", async () => {
    const r = await request(app).get(c.cb).query({ error: "access_denied", state: st(c, "redesign_studio") });
    expect(r.headers.location).toBe(`${V2}?system=${c.system}&error=denied`);
  });

  it("★ a failed token exchange → error=token_exchange_failed (or callback_error), never the provider's text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => bad));
    const r = await request(app).get(c.cb).query({ code: "c", state: st(c, "redesign_studio") });
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(new RegExp(`^${V2}\\?system=${c.system}&error=(token_exchange_failed|callback_error)$`));
    expect(r.headers.location).not.toContain("script");
  });

  it("★ success → connected=1", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ access_token: "a", refresh_token: "r", expires_in: 3600, email: "x@y.z", resource: { email: "x@y.z" }, api_domain: "https://www.zohoapis.com" })));
    const r = await request(app).get(c.cb).query({ code: "c", state: st(c, "redesign_studio") });
    expect(r.headers.location).toBe(`${V2}?system=${c.system}&connected=1`);
  });

  it("a legacy flow is untouched", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ access_token: "a", refresh_token: "r", expires_in: 3600, email: "x@y.z", resource: { email: "x@y.z" }, api_domain: "https://www.zohoapis.com" })));
    const r = await request(app).get(c.cb).query({ code: "c", state: st(c, "onboarding") });
    expect(r.headers.location).toBe(`https://app.example.test/setup?connected=${c.system}`);
  });
});

describe("the shared landing", () => {
  it("unknown codes become callback_error", () => {
    expect(redesignCapabilitiesUrl("stripe", { error: "provider said <b>no</b>" })).toBe(`${V2}?system=stripe&error=callback_error`);
  });
  it("the flow list is closed", () => {
    expect(parseConnectFlow("redesign_studio")).toBe("redesign_studio");
    expect(parseConnectFlow("/v2/anything")).toBeUndefined();
  });
});
