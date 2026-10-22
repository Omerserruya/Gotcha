/**
 * Drive / Confluence "Connect" from the redesigned app: flow=redesign_studio.
 *
 * Lands on {origin}/studio/knowledge?add=1&way=<drive|confluence>&connected=1
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

const DB = vi.hoisted(() => ({ writes: [] as any[], data: [] as any[], bases: [] as any[], atCapacity: false, capacityAsked: 0 }));
vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: {
      knowledgeBase: {
        create: async (a: any) => { const kb = { id: `kb_new_${DB.bases.length + 1}`, ...a.data }; DB.bases.push(kb); return kb; },
        count: async () => 0,
      },
      knowledgeIntegration: {
        findFirst: async () => null,
        create: async (a: any) => { DB.writes.push(["create", a.data.provider]); DB.data.push(a.data); return { id: "ki_1" }; },
        update: async () => ({ id: "ki_1" }),
      },
    },
    authenticate: (req: any, _r: any, n: any) => { req.userId = "user_1"; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "tenant_a"; n(); },
    requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requireOnboardingOrActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requireRole: () => (_q: any, _s: any, n: any) => n(),
    // 2026-10-09: init gates on ai:knowledge:write (pinned in connect-oauth-permissions.test.ts).
    requirePermissionOrRole: () => (_q: any, _s: any, n: any) => n(),
    requireEntitlement: () => (_q: any, _s: any, n: any) => n(),
    // A new base is held to capacity at init; a test flips it full.
    requireCapacity: () => (_q: any, res: any, n: any) => { DB.capacityAsked++; return DB.atCapacity ? res.status(403).json({ error: "limit_reached" }) : n(); },
  };
});

import router from "../routes/knowledge-oauth";
import { mintOAuthState } from "@chatcenter/shared";

const app = express();
app.use(express.json());
app.use("/api/knowledge", router);

const ok = (body: any) => ({ ok: true, json: async () => body, text: async () => JSON.stringify(body) });
const bad = { ok: false, json: async () => ({}), text: async () => "provider said no" };
const V2 = "https://app.example.test/studio/knowledge";

const st = (provider: string, flow?: string) =>
  mintOAuthState({ tenantId: "tenant_a", provider, kbId: "kb_1", flow, userId: "user_1" }).state;
const cb = (path: string, q: Record<string, string>) => request(app).get(`/api/knowledge/oauth/${path}/callback`).query(q);
const flowOf = (url: string) =>
  JSON.parse(Buffer.from(new URL(url).searchParams.get("state")!.split(".")[1], "base64url").toString()).flow;

beforeEach(() => { R.used.clear(); DB.writes = []; DB.data = []; DB.bases = []; DB.atCapacity = false; DB.capacityAsked = 0; vi.unstubAllGlobals(); });

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
  it("★ drive → /studio/knowledge?add=1&way=drive&connected=1", async () => {
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

  it("★ the Confluence callback stores its tokens ENCRYPTED, like Drive", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) =>
      String(u).includes("accessible") ? ok([{ id: "cloud", name: "Site" }]) : ok({ access_token: "at_plain", refresh_token: "rt_plain", expires_in: 3600 })));
    await cb("confluence", { code: "c", state: st("confluence") });
    const stored = DB.data[0].credentials;
    expect(typeof stored).toBe("string");
    expect(stored).not.toContain("at_plain");
    expect(stored).not.toContain("rt_plain");
    const { decryptCredentials } = await import("@chatcenter/shared");
    expect(decryptCredentials(stored)).toMatchObject({ accessToken: "at_plain", refreshToken: "rt_plain", cloudId: "cloud" });
  });

  it("the old landings are unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) =>
      String(u).includes("oauth2.googleapis.com") ? ok({ access_token: "a", expires_in: 3600 }) : ok({})));
    expect((await cb("google-drive", { code: "c", state: st("google_drive") })).headers.location)
      .toBe("https://app.example.test/studio/knowledge?add=1&way=drive&connected=1");
    expect((await cb("google-drive", { code: "c", state: st("google_drive", "onboarding") })).headers.location)
      .toBe("https://app.example.test/onboarding");
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


describe("★ a new base is created only once the provider's grant works (2026-10-09)", () => {
  const stateOf = (url: string) => new URL(url).searchParams.get("state")!;
  const claimsOf = (url: string) => JSON.parse(Buffer.from(stateOf(url).split(".")[1], "base64url").toString());

  it.each(["confluence", "google-drive"])("%s init with newBaseName: no base yet, the name rides the state", async (p) => {
    const r = await request(app).get(`/api/knowledge/oauth/${p}/init`).query({ newBaseName: "  Help center  ", flow: "redesign_studio" });
    expect(r.status).toBe(200);
    expect(claimsOf(r.body.url)).toMatchObject({ newBaseName: "Help center" });
    expect(claimsOf(r.body.url).kbId).toBeUndefined();
    expect(DB.bases).toEqual([]);
    expect(DB.capacityAsked).toBe(1);
  });

  it.each(["confluence", "google-drive"])("%s init with neither kbId nor newBaseName: 400", async (p) => {
    expect((await request(app).get(`/api/knowledge/oauth/${p}/init`).query({})).status).toBe(400);
  });

  it("an existing base (kbId) skips the capacity check, as before", async () => {
    await request(app).get("/api/knowledge/oauth/confluence/init").query({ kbId: "kb_1" });
    expect(DB.capacityAsked).toBe(0);
  });

  it("at capacity, a new base is refused at init", async () => {
    DB.atCapacity = true;
    expect((await request(app).get("/api/knowledge/oauth/confluence/init").query({ newBaseName: "X" })).status).toBe(403);
  });

  it("confluence: the token exchange works, so the base is created and the integration lands on it", async () => {
    const init = await request(app).get("/api/knowledge/oauth/confluence/init").query({ newBaseName: "Wiki", flow: "redesign_studio" });
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).includes("accessible-resources") ? ok([{ id: "cloud1", name: "Acme" }]) : ok({ access_token: "a", refresh_token: "r", expires_in: 3600 })));
    const r = await cb("confluence", { code: "c", state: stateOf(init.body.url) });
    expect(r.status).toBe(302);
    expect(DB.bases).toEqual([expect.objectContaining({ tenantId: "tenant_a", name: "Wiki" })]);
    expect(DB.data[0]).toMatchObject({ provider: "confluence", knowledgeBaseId: DB.bases[0].id });
  });

  it("confluence: the token exchange fails, so no base is left behind", async () => {
    const init = await request(app).get("/api/knowledge/oauth/confluence/init").query({ newBaseName: "Wiki", flow: "redesign_studio" });
    vi.stubGlobal("fetch", vi.fn(async () => bad));
    await cb("confluence", { code: "c", state: stateOf(init.body.url) });
    expect(DB.bases).toEqual([]);
    expect(DB.data).toEqual([]);
  });

  it("confluence: a working token but no accessible site, so no base either", async () => {
    const init = await request(app).get("/api/knowledge/oauth/confluence/init").query({ newBaseName: "Wiki", flow: "redesign_studio" });
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).includes("accessible-resources") ? ok([]) : ok({ access_token: "a", refresh_token: "r", expires_in: 3600 })));
    await cb("confluence", { code: "c", state: stateOf(init.body.url) });
    expect(DB.bases).toEqual([]);
  });

  it("an existing base (kbId): no new base, the integration lands on kb_1", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).includes("accessible-resources") ? ok([{ id: "cloud1", name: "Acme" }]) : ok({ access_token: "a", refresh_token: "r", expires_in: 3600 })));
    await cb("confluence", { code: "c", state: st("confluence", "redesign_studio") });
    expect(DB.bases).toEqual([]);
    expect(DB.data[0]).toMatchObject({ knowledgeBaseId: "kb_1" });
  });

  it("drive: the same, a working grant creates the base", async () => {
    const init = await request(app).get("/api/knowledge/oauth/google-drive/init").query({ newBaseName: "Docs", flow: "redesign_studio" });
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).includes("/about") ? ok({ user: { displayName: "Me" } }) : ok({ access_token: "a", refresh_token: "r", expires_in: 3600 })));
    await cb("google-drive", { code: "c", state: stateOf(init.body.url) });
    expect(DB.bases.map((b) => b.name)).toEqual(["Docs"]);
    expect(DB.data[0]).toMatchObject({ provider: "google_drive", knowledgeBaseId: DB.bases[0].id });
  });

  it("drive: a failed grant leaves no base", async () => {
    const init = await request(app).get("/api/knowledge/oauth/google-drive/init").query({ newBaseName: "Docs" });
    vi.stubGlobal("fetch", vi.fn(async () => bad));
    await cb("google-drive", { code: "c", state: stateOf(init.body.url) });
    expect(DB.bases).toEqual([]);
  });

  it("not configured: 409 with code NOT_CONFIGURED (a 4xx, not a 500)", async () => {
    const saved = process.env.CONFLUENCE_CLIENT_ID;
    delete process.env.CONFLUENCE_CLIENT_ID;
    const r = await request(app).get("/api/knowledge/oauth/confluence/init").query({ newBaseName: "X" });
    process.env.CONFLUENCE_CLIENT_ID = saved;
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("NOT_CONFIGURED");
  });
});
