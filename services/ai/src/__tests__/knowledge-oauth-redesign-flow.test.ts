/**
 * Drive / Confluence "Connect" from the redesigned app: flow=redesign_studio.
 *
 * Lands on {origin}/v2/studio/knowledge?add=1&way=<drive|confluence>&connected=1
 * or &error=<closed code>. Real state signing and single-use consume (jwt + a
 * Redis double with SET NX); provider endpoints stubbed. Every other flow
 * answers exactly as before, and a URL-shaped flow is dropped at init.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.FRONTEND_URL = "https://app.example.test";
  process.env.OAUTH_STATE_SECRET = "oauth-state-secret-for-tests-only-32chars";
  process.env.CHANNEL_ENCRYPTION_KEY = "248b2b86ff1b58bb208e102890ba28f2dd0c5c7dbc45fb81ae3d28531044ef37";
  process.env.GOOGLE_CLIENT_ID = "g-client";
  process.env.GOOGLE_CLIENT_SECRET = "g-secret";
  process.env.GOOGLE_REDIRECT_URI = "https://app.example.test/api/knowledge/oauth/google-drive/callback";
  process.env.CONFLUENCE_CLIENT_ID = "c-client";
  process.env.CONFLUENCE_CLIENT_SECRET = "c-secret";
  process.env.CONFLUENCE_REDIRECT_URI = "https://app.example.test/api/knowledge/oauth/confluence/callback";
});

const R = vi.hoisted(() => ({ used: new Set<string>() }));
vi.mock("ioredis", () => ({
  default: class {
    publish = vi.fn(); on = vi.fn(); subscribe = vi.fn(); quit = vi.fn();
    async set(key: string) { if (R.used.has(key)) return null; R.used.add(key); return "OK"; }
  },
}));
vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));

const DB = vi.hoisted(() => ({ writes: [] as any[] }));
vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: {
      knowledgeIntegration: {
        findFirst: async () => null,
        create: async (a: any) => { DB.writes.push(["create", a.data.provider]); return { id: "ki_1" }; },
        update: async () => ({ id: "ki_1" }),
      },
    },
    authenticate: (req: any, _r: any, n: any) => { req.userId = "user_1"; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "tenant_a"; n(); },
    requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requireOnboardingOrActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requireRole: () => (_q: any, _s: any, n: any) => n(),
  };
});

import router from "../routes/knowledge-oauth";
import { mintOAuthState } from "@chatcenter/shared";

const app = express();
app.use(express.json());
app.use("/api/knowledge", router);

const ok = (body: any) => ({ ok: true, json: async () => body, text: async () => JSON.stringify(body) });
const bad = { ok: false, json: async () => ({}), text: async () => "provider said no" };
const V2 = "https://app.example.test/v2/studio/knowledge";

const st = (provider: string, flow?: string) =>
  mintOAuthState({ tenantId: "tenant_a", provider, kbId: "kb_1", flow, userId: "user_1" }).state;
const cb = (path: string, q: Record<string, string>) => request(app).get(`/api/knowledge/oauth/${path}/callback`).query(q);
const flowOf = (url: string) =>
  JSON.parse(Buffer.from(new URL(url).searchParams.get("state")!.split(".")[1], "base64url").toString()).flow;

beforeEach(() => { R.used.clear(); DB.writes = []; vi.unstubAllGlobals(); });

describe("init: the flow is a closed list signed into the state", () => {
  it("drive and confluence accept redesign_studio", async () => {
    const d = await request(app).get("/api/knowledge/oauth/google-drive/init").query({ kbId: "kb_1", flow: "redesign_studio" });
    const c = await request(app).get("/api/knowledge/oauth/confluence/init").query({ kbId: "kb_1", flow: "redesign_studio" });
    expect(flowOf(d.body.url)).toBe("redesign_studio");
    expect(flowOf(c.body.url)).toBe("redesign_studio");
  });

  it.each(["https://evil.example", "/v2/x", "settings_business_systems"])("★ drive drops flow %s", async (flow) => {
    const d = await request(app).get("/api/knowledge/oauth/google-drive/init").query({ kbId: "kb_1", flow });
    expect(flowOf(d.body.url)).toBeUndefined();
  });

  it("drive still carries onboarding; confluence never did and still does not", async () => {
    const d = await request(app).get("/api/knowledge/oauth/google-drive/init").query({ kbId: "kb_1", flow: "onboarding" });
    const c = await request(app).get("/api/knowledge/oauth/confluence/init").query({ kbId: "kb_1", flow: "onboarding" });
    expect(flowOf(d.body.url)).toBe("onboarding");
    expect(flowOf(c.body.url)).toBeUndefined();
  });
});

describe("success", () => {
  it("★ drive → /v2/studio/knowledge?add=1&way=drive&connected=1", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) =>
      String(u).includes("oauth2.googleapis.com") ? ok({ access_token: "a", refresh_token: "r", expires_in: 3600 }) : ok({ user: { displayName: "Omer" } })));
    const res = await cb("google-drive", { code: "c", state: st("google_drive", "redesign_studio") });
    expect(res.headers.location).toBe(`${V2}?add=1&way=drive&connected=1`);
    expect(DB.writes).toEqual([["create", "google_drive"]]);
  });

  it("★ confluence → way=confluence&connected=1", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) =>
      String(u).includes("oauth/token/accessible") ? ok([{ id: "cloud", name: "Site" }]) : ok({ access_token: "a", refresh_token: "r", expires_in: 3600 })));
    const res = await cb("confluence", { code: "c", state: st("confluence", "redesign_studio") });
    expect(res.headers.location).toBe(`${V2}?add=1&way=confluence&connected=1`);
  });

  it("the old landings are unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) =>
      String(u).includes("oauth2.googleapis.com") ? ok({ access_token: "a", expires_in: 3600 }) : ok({})));
    expect((await cb("google-drive", { code: "c", state: st("google_drive") })).headers.location)
      .toBe("https://app.example.test/knowledge?connected=google_drive");
    expect((await cb("google-drive", { code: "c", state: st("google_drive", "onboarding") })).headers.location)
      .toBe("https://app.example.test/setup?connected=google_drive");
  });
});

describe("failure: redesign gets a closed code, everyone else the old JSON", () => {
  it("★ token exchange failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => bad));
    const r = await cb("google-drive", { code: "c", state: st("google_drive", "redesign_studio") });
    expect(r.headers.location).toBe(`${V2}?add=1&way=drive&error=token_exchange_failed`);
    const legacy = await cb("google-drive", { code: "c", state: st("google_drive") });
    expect(legacy.status).toBe(400);
    expect(legacy.body).toEqual({ error: "Token exchange failed" });
    expect(DB.writes).toEqual([]);
  });

  it("confluence with no accessible site → error=no_accessible_site", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) =>
      String(u).includes("accessible") ? ok([]) : ok({ access_token: "a", expires_in: 3600 })));
    const r = await cb("confluence", { code: "c", state: st("confluence", "redesign_studio") });
    expect(r.headers.location).toBe(`${V2}?add=1&way=confluence&error=no_accessible_site`);
  });

  it("★ an exception → error=callback_error, message not in the URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("secret-ish detail"); }));
    const r = await cb("confluence", { code: "c", state: st("confluence", "redesign_studio") });
    expect(r.headers.location).toBe(`${V2}?add=1&way=confluence&error=callback_error`);
    expect(r.headers.location).not.toContain("secret");
  });
});

describe("Cancel at the provider (?error=, no code)", () => {
  it("★ redesign → error=denied", async () => {
    const r = await cb("google-drive", { error: "access_denied", state: st("google_drive", "redesign_studio") });
    expect(r.headers.location).toBe(`${V2}?add=1&way=drive&error=denied`);
  });

  it("legacy flow → the same JSON as before", async () => {
    const r = await cb("google-drive", { error: "access_denied", state: st("google_drive", "onboarding") });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "Missing code or state" });
  });

  it("★ another provider's state cannot choose the redesign landing", async () => {
    const r = await cb("google-drive", { error: "access_denied", state: st("confluence", "redesign_studio") });
    expect(r.status).toBe(400);
    expect(r.headers.location).toBeUndefined();
  });

  it("a state spent on Cancel cannot be replayed into a connect", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ access_token: "a", expires_in: 3600 })));
    const s = st("google_drive", "redesign_studio");
    await cb("google-drive", { error: "access_denied", state: s });
    const replay = await cb("google-drive", { code: "c", state: s });
    expect(replay.status).toBe(400);
    expect(DB.writes).toEqual([]);
  });
});
