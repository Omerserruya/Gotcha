/**
 * "Connect" from the redesigned app: the `redesign_studio` OAuth flow.
 *
 * The callback used to return only to the old app's routes. The new flow lands
 * on `/studio/capabilities?system=<slug>&connected=1`, or `&error=<code>`.
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
  process.env.STRIPE_CLIENT_ID = "ca_test";
  process.env.STRIPE_REDIRECT_URI = "https://app.gotcha.co.il/api/connectors/stripe/oauth/callback";
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  process.env.MONDAY_CLIENT_ID = "m-client";
  process.env.MONDAY_CLIENT_SECRET = "m-secret";
  process.env.MONDAY_REDIRECT_URI = "https://app.gotcha.co.il/api/connectors/monday/oauth/callback";
  process.env.SALESFORCE_CLIENT_ID = "sf-client";
  process.env.SALESFORCE_CLIENT_SECRET = "sf-secret";
  process.env.SALESFORCE_REDIRECT_URI = "https://app.gotcha.co.il/api/connectors/salesforce/oauth/callback";
  process.env.AIRTABLE_CLIENT_ID = "at-client";
  process.env.AIRTABLE_REDIRECT_URI = "https://app.gotcha.co.il/api/connectors/airtable/oauth/callback";
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
  it("★ hubspot → /studio/capabilities?system=hubspot&connected=1, on the fixed origin", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => tokenOk));
    const res = await callback("hubspot", { code: "c", state: stateFor("hubspot", "redesign_studio") });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://app.gotcha.co.il/studio/capabilities?system=hubspot&connected=1");
    expect(C.upserts).toHaveLength(1);
  });

  it("monday validation failure → error=validation_failed, without connected=1", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) =>
      String(u).includes("oauth2/token") ? tokenOk : { ok: true, json: async () => ({ data: {} }) }));
    const res = await callback("monday", { code: "c", state: stateFor("monday", "redesign_studio") });
    expect(res.headers.location).toBe("https://app.gotcha.co.il/studio/capabilities?system=monday&error=validation_failed");
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
    expect(res.headers.location).toBe("https://app.gotcha.co.il/studio/capabilities?system=hubspot&error=token_exchange_failed");
    expect(C.upserts).toHaveLength(0);
  });

  it("★ an exception → error=callback_error; its message never reaches the URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("secret-ish detail"); }));
    const res = await callback("hubspot", { code: "c", state: stateFor("hubspot", "redesign_studio") });
    expect(res.headers.location).toBe("https://app.gotcha.co.il/studio/capabilities?system=hubspot&error=callback_error");
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
    expect(res.headers.location).toBe("https://app.gotcha.co.il/studio/capabilities?system=hubspot&error=denied");
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
    // 2026-10-09: refused on v2 with a closed code, not plain text.
    expect(replay.status).toBe(302);
    expect(replay.headers.location).toBe("https://app.gotcha.co.il/studio/capabilities?system=hubspot&error=invalid_state");
    expect(C.upserts).toHaveLength(0);
  });
});

// 2026-10-09: refusals BEFORE the state verifies answered plain text on the
// API host and stranded the browser. They land on v2 now, for every flow.
describe("refused before the state verifies: the browser lands on v2", () => {
  const V2 = "https://app.gotcha.co.il/studio/capabilities";
  const SLUGS = ["hubspot", "stripe", "monday", "salesforce", "airtable"] as const;

  it.each(SLUGS)("★ %s: a forged state → error=invalid_state, nothing exchanged or written", async (slug) => {
    const fetchSpy = vi.fn(async () => tokenOk);
    vi.stubGlobal("fetch", fetchSpy);
    const res = await callback(slug, { code: "c", state: "eyJhbGciOiJIUzI1NiJ9.eyJmbG93IjoicmVkZXNpZ25fc3R1ZGlvIn0.x" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${V2}?system=${slug}&error=invalid_state`);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(C.upserts).toHaveLength(0);
  });

  it.each(SLUGS)("★ %s: a state minted for another provider → error=invalid_state", async (slug) => {
    vi.stubGlobal("fetch", vi.fn(async () => tokenOk));
    const res = await callback(slug, { code: "c", state: stateFor(slug === "hubspot" ? "monday" : "hubspot", "redesign_studio") });
    expect(res.headers.location).toBe(`${V2}?system=${slug}&error=invalid_state`);
    expect(C.upserts).toHaveLength(0);
  });

  it.each(SLUGS)("★ %s: no code → error=callback_error, and the state is not spent", async (slug) => {
    vi.stubGlobal("fetch", vi.fn(async () => tokenOk));
    const state = stateFor(slug, "onboarding");
    const res = await callback(slug, { state });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${V2}?system=${slug}&error=callback_error`);
    // Still usable: a missing code proves nothing about the state.
    const later = await callback(slug, { code: "c", state });
    expect(later.status).toBe(302);
    expect(later.headers.location).not.toContain("invalid_state");
  });

  it("the landing is on the configured origin, whatever Host the request names", async () => {
    const res = await request(app).get("/api/connectors/hubspot/oauth/callback")
      .set("Host", "evil.example").set("X-Forwarded-Host", "evil.example")
      .query({ code: "c", state: "bogus" });
    expect(new URL(res.headers.location).origin).toBe("https://app.gotcha.co.il");
  });

  it("with no FRONTEND_URL in production the landing is relative, never a 500", async () => {
    const saved = { env: process.env.NODE_ENV, url: process.env.FRONTEND_URL };
    process.env.NODE_ENV = "production";
    delete process.env.FRONTEND_URL;
    try {
      const res = await callback("hubspot", { code: "c", state: "bogus" });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/studio/capabilities?system=hubspot&error=invalid_state");
    } finally {
      process.env.NODE_ENV = saved.env;
      process.env.FRONTEND_URL = saved.url;
    }
  });

  it("★ Airtable: the provider's error text is never echoed back", async () => {
    const res = await callback("airtable", { error: "<script>alert(1)</script>", code: "c", state: "s" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${V2}?system=airtable&error=denied`);
    expect(res.text ?? "").not.toContain("<script>");
    const unverified = await callback("airtable", { error: "<script>alert(1)</script>", state: "eyJhbGciOiJIUzI1NiJ9.e30.x" });
    expect(unverified.status).toBe(400);
    expect(unverified.text).toBe("airtable_oauth_error");
  });
});

describe("Stripe (it carried no flow and answered failures in plain text)", () => {
  it("init carries redesign_studio only", async () => {
    const r = await request(app).get("/api/connectors/stripe/oauth/init").query({ flow: "redesign_studio" });
    expect(JSON.parse(Buffer.from(new URL(r.body.url).searchParams.get("state")!.split(".")[1], "base64url").toString()).flow).toBe("redesign_studio");
  });

  it("★ success → /studio/capabilities?system=stripe&connected=1", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => tokenOk));
    const r = await callback("stripe", { code: "c", state: stateFor("stripe", "redesign_studio") });
    expect(r.headers.location).toBe("https://app.gotcha.co.il/studio/capabilities?system=stripe&connected=1");
  });

  it("★ failures redirect with a closed code instead of plain text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => tokenFail));
    const r = await callback("stripe", { code: "c", state: stateFor("stripe", "redesign_studio") });
    expect(r.headers.location).toBe("https://app.gotcha.co.il/studio/capabilities?system=stripe&error=token_exchange_failed");
    const cancel = await callback("stripe", { error: "access_denied", state: stateFor("stripe", "redesign_studio") });
    expect(cancel.headers.location).toBe("https://app.gotcha.co.il/studio/capabilities?system=stripe&error=denied");
  });

  it("without the flow Stripe answers exactly as before", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => tokenFail));
    const r = await callback("stripe", { code: "c", state: stateFor("stripe") });
    expect(r.status).toBe(400);
    expect(r.text).toBe("token_exchange_failed");
    vi.stubGlobal("fetch", vi.fn(async () => tokenOk));
    const ok = await callback("stripe", { code: "c", state: stateFor("stripe") });
    expect(ok.headers.location).toContain("/ai-studio/marketplace/stripe?status=connected");
  });
});

// 2026-10-09: "not configured" carries a machine code next to the text.
describe("an unconfigured provider answers code NOT_CONFIGURED", () => {
  it.each([
    ["stripe", "STRIPE_CLIENT_ID"],
    ["hubspot", "HUBSPOT_CLIENT_ID"],
    ["airtable", "AIRTABLE_CLIENT_ID"],
    ["salesforce", "SALESFORCE_REDIRECT_URI"],
    ["monday", "MONDAY_CLIENT_ID"],
    ["wix", "WIX_CLIENT_ID"],
    ["square", "SQUARE_APPLICATION_ID"],
    ["shopify", "SHOPIFY_API_KEY"],
  ])("%s init", async (slug, envName) => {
    const saved = process.env[envName];
    delete process.env[envName];
    try {
      const res = await request(app).get(`/api/connectors/${slug}/oauth/init`).query({ flow: "redesign_studio" });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: `${slug}_oauth_not_configured`, code: "NOT_CONFIGURED" });
    } finally {
      if (saved === undefined) delete process.env[envName];
      else process.env[envName] = saved;
    }
  });
});
