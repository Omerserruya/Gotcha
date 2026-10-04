/**
 * "Connect" from the redesigned app: the `redesign_studio` OAuth flow.
 *
 * The callback used to return only to the old app's routes. The new flow lands
 * on `/v2/studio/capabilities?system=<slug>&connected=1`, or `&error=<code>`.
 *
 * What must hold, and is checked here with the REAL state signing and
 * single-use consume (jwt + a Redis double with SET NX semantics) - no real
 * provider, the token endpoint is stubbed:
 *   - the flow is a CLOSED list: an unknown or URL-shaped flow is dropped and
 *     lands on the default, never on a destination from the query;
 *   - the destination is fixed: base origin + /v2, nothing from the request;
 *   - failure codes in the URL are a closed set; an exception message never
 *     reaches it;
 *   - every OTHER flow answers exactly as before (plain text), byte for byte;
 *   - a state that does not verify cannot choose the redesign landing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.FRONTEND_URL = "https://app.gotcha.co.il";
  process.env.OAUTH_STATE_SECRET = "oauth-state-secret-for-tests-only-32chars";
  process.env.CHANNEL_ENCRYPTION_KEY = "a".repeat(64);
  process.env.HUBSPOT_CLIENT_ID = "hs-client";
  process.env.HUBSPOT_CLIENT_SECRET = "hs-secret";
  process.env.HUBSPOT_REDIRECT_URI = "https://app.gotcha.co.il/api/connectors/hubspot/oauth/callback";
  process.env.MONDAY_CLIENT_ID = "m-client";
  process.env.MONDAY_CLIENT_SECRET = "m-secret";
  process.env.MONDAY_REDIRECT_URI = "https://app.gotcha.co.il/api/connectors/monday/oauth/callback";
});

const R = vi.hoisted(() => ({ used: new Set<string>() }));

vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({
  default: class {
    publish = vi.fn(); on = vi.fn(); subscribe = vi.fn(); quit = vi.fn();
    // SET key val EX ttl NX - the single-use claim consumeOAuthState makes.
    async set(key: string, _v: string, ..._rest: unknown[]) {
      if (R.used.has(key)) return null;
      R.used.add(key);
      return "OK";
    }
  },
}));
vi.mock("@prisma/client", () => ({ PrismaClient: class { $extends() { return this; } } }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    authenticate: (req: any, _res: any, next: any) => { req.user = { userId: "user-1", role: "ADMIN" }; next(); },
    resolveTenant: (req: any, _res: any, next: any) => { req.tenantId = "tenant-A"; next(); },
    requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requireOnboardingOrActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requirePermission: () => (_q: any, _s: any, n: any) => n(),
  };
});

const C = vi.hoisted(() => ({ catalog: { current: { id: "cat" } as any }, upserts: [] as any[] }));
vi.mock("../services/connector-connection.service", () => ({
  findCatalog: vi.fn(async () => C.catalog.current),
  upsertConnection: vi.fn(async (a: any) => { C.upserts.push(a); return { id: "conn-1" }; }),
}));
vi.mock("../services/connectors/integration-framework", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  loadConnection: vi.fn(async () => null),
  refreshCapabilityState: vi.fn(async () => ({ missingScopes: [] })),
}));
vi.mock("../services/tool-permission-reconcile.service", () => ({
  reconcileAgentToolPermissions: vi.fn(async () => ({ added: [] })),
}));
vi.mock("../services/integration-provisioning.service", () => ({
  provisionIntegrationTools: vi.fn(async () => ({ granted: 0, preserved: 0, byCategory: {} })),
}));

import router from "../routes/connectors-admin";
import { mintOAuthState } from "@chatcenter/shared";

const app = express();
app.use("/api", router);

const tokenOk = { ok: true, json: async () => ({ access_token: "t", refresh_token: "r", expires_in: 1800 }), text: async () => "" };
const tokenFail = { ok: false, json: async () => ({}), text: async () => "provider said no <script>" };

beforeEach(() => {
  R.used.clear();
  C.upserts = [];
  C.catalog.current = { id: "cat" };
  vi.unstubAllGlobals();
});

const stateFor = (provider: string, flow?: string) =>
  mintOAuthState({ tenantId: "tenant-A", provider, flow, userId: "user-1" }).state;
const callback = (provider: string, q: Record<string, string>) =>
  request(app).get(`/api/connectors/${provider}/oauth/callback`).query(q);

describe("the flow is a closed list, bound into the signed state", () => {
  it("init accepts redesign_studio and signs it into the state", async () => {
    const res = await request(app).get("/api/connectors/hubspot/oauth/init").query({ flow: "redesign_studio" });
    const url = new URL(res.body.url ?? res.headers.location);
    const state = url.searchParams.get("state")!;
    const claims = JSON.parse(Buffer.from(state.split(".")[1], "base64url").toString());
    expect(claims.flow).toBe("redesign_studio");
  });

  it.each(["https://evil.example/x", "//evil.example", "/v2/anything", "REDESIGN_STUDIO"])(
    "★ an unknown flow %s is dropped, not carried",
    async (flow) => {
      const res = await request(app).get("/api/connectors/hubspot/oauth/init").query({ flow });
      const url = new URL(res.body.url ?? res.headers.location);
      const claims = JSON.parse(Buffer.from(url.searchParams.get("state")!.split(".")[1], "base64url").toString());
      expect(claims.flow).toBeUndefined();
    },
  );
});

describe("success lands on the redesigned studio", () => {
  it("★ hubspot → /v2/studio/capabilities?system=hubspot&connected=1, on the fixed origin", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => tokenOk));
    const res = await callback("hubspot", { code: "c", state: stateFor("hubspot", "redesign_studio") });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://app.gotcha.co.il/v2/studio/capabilities?system=hubspot&connected=1");
    expect(C.upserts).toHaveLength(1);
  });

  it("monday validation failure → error=validation_failed, without connected=1", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) =>
      String(u).includes("oauth2/token") ? tokenOk : { ok: true, json: async () => ({ data: {} }) }));
    const res = await callback("monday", { code: "c", state: stateFor("monday", "redesign_studio") });
    expect(res.headers.location).toBe("https://app.gotcha.co.il/v2/studio/capabilities?system=monday&error=validation_failed");
  });

  it("the other flows still land where they did", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => tokenOk));
    const res = await callback("hubspot", { code: "c", state: stateFor("hubspot", "settings_business_systems") });
    expect(res.headers.location).toBe("https://app.gotcha.co.il/settings/business-systems?connected=hubspot");
  });
});

describe("failure: the redesign flow gets a closed error code, everyone else the old text", () => {
  it("★ token exchange failed → error=token_exchange_failed; the provider's text is NOT in the URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => tokenFail));
    const res = await callback("hubspot", { code: "c", state: stateFor("hubspot", "redesign_studio") });
    expect(res.headers.location).toBe("https://app.gotcha.co.il/v2/studio/capabilities?system=hubspot&error=token_exchange_failed");
    expect(C.upserts).toHaveLength(0);
  });

  it("★ an exception → error=callback_error; its message never reaches the URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("secret-ish detail"); }));
    const res = await callback("hubspot", { code: "c", state: stateFor("hubspot", "redesign_studio") });
    expect(res.headers.location).toBe("https://app.gotcha.co.il/v2/studio/capabilities?system=hubspot&error=callback_error");
    expect(res.headers.location).not.toContain("secret");
  });

  it("missing catalog → error=catalog_missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => tokenOk));
    C.catalog.current = null;
    const res = await callback("hubspot", { code: "c", state: stateFor("hubspot", "redesign_studio") });
    expect(res.headers.location).toContain("error=catalog_missing");
  });

  it("★ the same failures on a legacy flow answer exactly as before", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => tokenFail));
    const res = await callback("hubspot", { code: "c", state: stateFor("hubspot", "onboarding") });
    expect(res.status).toBe(400);
    expect(res.text).toBe("token_exchange_failed");
  });
});

describe("the user pressed Cancel at the provider (?error=, no code)", () => {
  it("★ redesign flow → error=denied", async () => {
    const res = await callback("hubspot", { error: "access_denied", state: stateFor("hubspot", "redesign_studio") });
    expect(res.headers.location).toBe("https://app.gotcha.co.il/v2/studio/capabilities?system=hubspot&error=denied");
  });

  it("legacy flow → the same plain response as before", async () => {
    const res = await callback("hubspot", { error: "access_denied", state: stateFor("hubspot", "onboarding") });
    expect(res.status).toBe(400);
    expect(res.text).toBe("missing_code_or_state");
  });

  it("★ a forged or foreign state cannot choose the redesign landing", async () => {
    const res = await callback("hubspot", { error: "access_denied", state: stateFor("monday", "redesign_studio") });
    expect(res.status).toBe(400);
    expect(res.headers.location).toBeUndefined();
    const forged = await callback("hubspot", { error: "access_denied", state: "eyJhbGciOiJIUzI1NiJ9.eyJmbG93IjoicmVkZXNpZ25fc3R1ZGlvIn0.x" });
    expect(forged.status).toBe(400);
    expect(forged.headers.location).toBeUndefined();
  });

  it("a state spent on Cancel cannot be replayed into a connect", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => tokenOk));
    const state = stateFor("hubspot", "redesign_studio");
    await callback("hubspot", { error: "access_denied", state });
    const replay = await callback("hubspot", { code: "c", state });
    expect(replay.status).toBe(400);
    expect(replay.text).toBe("state_already_used");
    expect(C.upserts).toHaveLength(0);
  });
});
