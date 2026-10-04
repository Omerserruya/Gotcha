/**
 * Channel "Connect" from the redesigned app: flow=redesign_studio.
 *
 * The callback lands on {origin}/v2/settings/channels?connected=<platform>&count=N
 * or ?platform=<p>&error=<code> from a closed list. Every other flow keeps its
 * exact old answer. And init has a BFF variant, /oauth/init-url, that takes the
 * caller's normal credentials and answers JSON { url } - the redirect variant
 * needs the user's token in the query string, which a BFF browser does not have.
 *
 * The REAL state store (signature + single-use) runs; Gmail is the platform
 * driven end to end because its success path needs only two provider calls.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Read at module load in channels.ts, so they have to be set before the import
// below runs. vi.hoisted lifts this above the hoisted import statements.
vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.SLACK_CLIENT_ID = "";
  process.env.GOOGLE_CLIENT_ID = "client-id-under-test";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret-under-test";
  process.env.GOOGLE_OAUTH_REDIRECT_URI = "https://dev.example.test/api/channels/oauth/callback";
  process.env.APP_PUBLIC_URL = "https://dev.example.test";
  process.env.FRONTEND_URL = "https://dev.example.test";
  process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret-0123456789abcdef";
  process.env.CHANNEL_ENCRYPTION_KEY =
    "248b2b86ff1b58bb208e102890ba28f2dd0c5c7dbc45fb81ae3d28531044ef37";
});

// ─── What the route saw and did ──────────────────────────────

const state = {
  /** Every URL axios was asked for, so an unexpected host is visible. */
  gets: [] as string[],
  posts: [] as string[],
  channelWrites: [] as any[],
  stateStore: new Map<string, string>(),
};

const mocks = vi.hoisted(() => ({ prismaMock: {} as any }));
const R = vi.hoisted(() => ({ used: new Set<string>() }));
// The REAL state store runs (jwt signature + single-use jti); only Redis is
// doubled, with SET NX semantics, so "replayed" is a real outcome here.
vi.mock("ioredis", () => ({
  default: class {
    on = vi.fn(); quit = vi.fn(); publish = vi.fn(); subscribe = vi.fn();
    async set(key: string, _v: string, ...rest: unknown[]) {
      if (rest.includes("NX") && R.used.has(key)) return null;
      R.used.add(key);
      return "OK";
    }
    async get() { return null; }
    async del() { return 0; }
  },
}));

vi.mock("axios", () => {
  const get = async (url: string, _cfg?: any) => {
    state.gets.push(url);
    if (url === "https://gmail.googleapis.com/gmail/v1/users/me/profile") {
      return { data: { emailAddress: "support@acme.test", historyId: 111 } };
    }
    // Anything else is a call this flow should no longer be making. Fail the
    // way Google would if the token lacked the scope, so a regression shows up
    // as a broken connect rather than a silently different code path.
    const err: any = new Error("insufficient authentication scopes");
    err.response = { status: 403, data: { error: "insufficient_scope", url } };
    throw err;
  };
  const post = async (url: string, _body?: any, _cfg?: any) => {
    state.posts.push(url);
    if (url === "https://oauth2.googleapis.com/token") {
      return {
        data: { access_token: "at_1", refresh_token: "rt_1", expires_in: 3600 },
      };
    }
    if (url === "https://gmail.googleapis.com/gmail/v1/users/me/watch") {
      return { data: { historyId: 222, expiration: "1900000000000" } };
    }
    const err: any = new Error("unexpected post");
    err.response = { status: 403, data: { url } };
    throw err;
  };
  const axiosMock = { get, post, delete: async () => ({ data: {} }) };
  return { default: axiosMock, ...axiosMock };
});

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: mocks.prismaMock,
    getRedis: () => ({
      get: async (k: string) => state.stateStore.get(k) ?? null,
      set: async (k: string, v: string) => {
        state.stateStore.set(k, v);
        return "OK";
      },
      del: async (k: string) => (state.stateStore.delete(k) ? 1 : 0),
    }),
    // The auth gate has its own tests; this suite is about the Google ask.
    authenticate: (req: any, _res: any, next: any) => {
      req.user = { userId: "user_1", role: "ADMIN" };
      next();
    },
    resolveTenant: (req: any, _res: any, next: any) => {
      req.tenantId = "tenant_a";
      next();
    },
    resolvePrincipal: async () => ({
      userId: "user_1",
      tenantId: "tenant_a",
      role: "ADMIN",
    }),
    requirePermission: () => (_req: any, _res: any, next: any) => next(),
    requireCapacity: () => (_req: any, _res: any, next: any) => next(),
    validate: () => (_req: any, _res: any, next: any) => next(),
  };
});

import { mintOAuthState } from "@chatcenter/shared";
import { redesignChannelsUrl, embeddedSignupFor } from "../routes/channels";
import channelsRouter from "../routes/channels";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/channels", channelsRouter);
  return a;
}

beforeEach(() => {
  state.gets = [];
  state.posts = [];
  state.channelWrites = [];
  state.stateStore.clear();
  R.used.clear();

  mocks.prismaMock.channelAccount = {
    count: async () => 0,
    findUnique: async () => null,
    findFirst: async () => null,
    findMany: async () => [],
    create: async (args: any) => {
      state.channelWrites.push(args.data);
      return { id: "ca_1", ...args.data };
    },
    update: async (args: any) => {
      state.channelWrites.push(args.data);
      return { id: "ca_1", ...args.data };
    },
  };
  mocks.prismaMock.routerRule = {
    findMany: async () => [],
    create: async (args: any) => args.data,
    update: async (args: any) => args.data,
  };
  mocks.prismaMock.$transaction = async (ops: any[]) => Promise.all(ops);
});


const V2 = "https://dev.example.test/v2/settings/channels";
const st = (platform: string, flow?: string) =>
  mintOAuthState({ tenantId: "tenant_a", provider: "meta_channels", userId: "user_1", platform, flow }).state;
const cb = (q: Record<string, string>) => request(app()).get("/api/channels/oauth/callback").query(q);
const flowInUrl = (u: string) =>
  JSON.parse(Buffer.from(new URL(u).searchParams.get("state")!.split(".")[1], "base64url").toString()).flow;

describe("init: the flow is a closed list signed into the state", () => {
  it("redirect variant carries redesign_studio", async () => {
    const r = await request(app()).get("/api/channels/oauth/init?platform=gmail&token=t&flow=redesign_studio");
    expect(flowInUrl(r.headers.location)).toBe("redesign_studio");
  });

  it.each(["https://evil.example", "/v2/x", "onboarding"])("★ drops flow %s", async (flow) => {
    const r = await request(app()).get(`/api/channels/oauth/init?platform=gmail&token=t&flow=${encodeURIComponent(flow)}`);
    expect(flowInUrl(r.headers.location)).toBeUndefined();
  });

  it("★ init-url answers JSON { url } to a caller authenticated the normal way - no token in the query", async () => {
    const r = await request(app()).get("/api/channels/oauth/init-url?platform=gmail&flow=redesign_studio");
    expect(r.status).toBe(200);
    expect(new URL(r.body.url).host).toBe("accounts.google.com");
    expect(flowInUrl(r.body.url)).toBe("redesign_studio");
  });

  it("init-url: an unconfigured platform is 409 naming THAT platform", async () => {
    const r = await request(app()).get("/api/channels/oauth/init-url?platform=slack");
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "not_configured", platform: "slack" });
  });

  it("★ the redirect variant's not_configured names the platform asked for (WhatsApp said messenger)", async () => {
    const r = await request(app()).get("/api/channels/oauth/init?platform=slack&token=t");
    expect(r.headers.location).toBe("https://dev.example.test/settings/channels?error=not_configured&platform=slack");
    const v2 = await request(app()).get("/api/channels/oauth/init?platform=slack&token=t&flow=redesign_studio");
    expect(v2.headers.location).toBe(`${V2}?platform=slack&error=not_configured`);
  });
});

describe("callback: success", () => {
  it("★ redesign flow → /v2/settings/channels?connected=gmail&count=1", async () => {
    const r = await cb({ code: "c", state: st("gmail", "redesign_studio") });
    expect(r.headers.location).toBe(`${V2}?connected=gmail&count=1`);
    expect(state.channelWrites.length).toBeGreaterThan(0);
  });

  it("no flow → exactly the old landing", async () => {
    const r = await cb({ code: "c", state: st("gmail") });
    expect(r.headers.location).toBe("https://dev.example.test/channels?connected=gmail&count=1");
  });
});

describe("callback: failures", () => {
  it("★ Cancel at the provider → error=denied for the redesign flow, the old answer otherwise", async () => {
    const r = await cb({ error: "access_denied", state: st("gmail", "redesign_studio") });
    expect(r.headers.location).toBe(`${V2}?platform=gmail&error=denied`);
    const legacy = await cb({ error: "access_denied", state: st("gmail") });
    expect(legacy.headers.location).toBe("https://dev.example.test/channels?error=access_denied");
  });

  it("★ a replayed redesign state still lands in v2, with state_already_used", async () => {
    const s = st("gmail", "redesign_studio");
    await cb({ code: "c", state: s });
    const replay = await cb({ code: "c", state: s });
    expect(replay.headers.location).toBe(`${V2}?platform=gmail&error=state_already_used`);
  });

  it("a forged state cannot pick the v2 landing", async () => {
    const r = await cb({ code: "c", state: "eyJhbGciOiJIUzI1NiJ9.eyJmbG93IjoicmVkZXNpZ25fc3R1ZGlvIn0.x" });
    expect(r.headers.location).toBe("https://dev.example.test/channels?error=invalid_state");
  });
});

describe("redesignChannelsUrl - the closed list", () => {
  const u = (q: string) => new URL(redesignChannelsUrl("https://o", "slack", q)).search;
  it("folds the callback's provider-specific codes onto the list", () => {
    expect(u("error=slack_already_connected")).toBe("?platform=slack&error=already_connected");
    expect(u("error=slack_token_failed")).toBe("?platform=slack&error=token_exchange_failed");
    expect(u("error=connection_failed")).toBe("?platform=slack&error=callback_error");
  });
  it("★ an unknown code - including a provider's own text - becomes callback_error", () => {
    expect(u("error=%3Cscript%3E")).toBe("?platform=slack&error=callback_error");
    expect(u("error=server_error")).toBe("?platform=slack&error=callback_error");
  });
  it("WhatsApp pending → pending=1", () => {
    expect(new URL(redesignChannelsUrl("https://o", "whatsapp", "connected=whatsapp&pending=true")).search)
      .toBe("?connected=whatsapp&pending=1");
  });
});

describe("WhatsApp: launch per onboarding choice (13c)", () => {
  const env = (o: Record<string, string>) => ({ META_APP_ID: "app", WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: "cfg", ...o }) as any;

  it("★ v4 (the default): both choices keep extras EMPTY - Meta's dialog makes the choice", () => {
    const coex = embeddedSignupFor("coexistence", env({}));
    const fresh = embeddedSignupFor("new_number", env({}));
    expect(coex.extras).toEqual({});
    expect(fresh.extras).toEqual({});
    expect(coex).toMatchObject({ mode: "coexistence", choiceMadeIn: "meta_dialog", inspectPath: "business-app" });
    expect(fresh).toMatchObject({ mode: "new_number", inspectPath: "new" });
  });

  it("★ v3: coexistence carries featureType whatsapp_business_app_onboarding; new_number never does", () => {
    expect(embeddedSignupFor("coexistence", env({ WHATSAPP_ES_VERSION: "v3" })).extras)
      .toMatchObject({ version: "v3", featureType: "whatsapp_business_app_onboarding" });
    // Even when the env forces a featureType globally, "a new number" drops it.
    expect(embeddedSignupFor("new_number", env({ WHATSAPP_ES_VERSION: "v3", WHATSAPP_ES_FEATURE_TYPE: "whatsapp_business_app_onboarding" })).extras)
      .not.toHaveProperty("featureType");
  });

  it("a dedicated Coexistence configuration is used when set", () => {
    expect(embeddedSignupFor("coexistence", env({ WHATSAPP_ES_COEXISTENCE_CONFIG_ID: "cfg_coex" })).configId).toBe("cfg_coex");
    expect(embeddedSignupFor("new_number", env({ WHATSAPP_ES_COEXISTENCE_CONFIG_ID: "cfg_coex" })).configId).toBe("cfg");
  });

  it("no choice is exactly the configured default", () => {
    expect(embeddedSignupFor(undefined, env({ WHATSAPP_ES_FEATURE_TYPE: "x" })).extras).toEqual({ featureType: "x" });
  });
});
