/**
 * ★ The Messenger Page picker (2026-10-09).
 *
 * A redesign-flow grant with more than one Page stores the candidates (tokens
 * encrypted, 15 minutes) and lands on the picker; one Page connects itself.
 * GET /messenger/candidates shows names only; POST /messenger/select connects
 * a subset of what was offered, through the same per-Page code the callback
 * runs, after checking the plan has room for the NEW Pages. The v1 flow keeps
 * connecting every Page, now with the same capacity check, and nothing saved
 * is an error instead of "connected, count=0".
 *
 * Every request goes through the real router and the real OAuth state store.
 * Redis, axios and prisma are doubled; the prisma double honours `where`
 * (including `not`), the Redis double honours keys and EX.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.META_APP_ID = "meta-app";
  process.env.META_APP_SECRET = "meta-secret";
  process.env.OAUTH_REDIRECT_URI = "https://dev.example.test/api/channels/oauth/callback";
  process.env.SLACK_CLIENT_ID = "";
  process.env.APP_PUBLIC_URL = "https://dev.example.test";
  process.env.FRONTEND_URL = "https://dev.example.test";
  process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret-0123456789abcdef";
  process.env.CHANNEL_ENCRYPTION_KEY = "248b2b86ff1b58bb208e102890ba28f2dd0c5c7dbc45fb81ae3d28531044ef37";
});

// ─── Doubles ─────────────────────────────────────────────────

/** The OAuth state store's own client: SET NX is what makes a state single-use. */
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
    async del() { return 0; }
  },
}));

const A = vi.hoisted(() => ({
  /** What /me/accounts answers. */
  pages: [] as any[],
  /** Page ids whose subscribe Meta refuses. */
  fail: new Set<string>(),
  /** Every page id a subscribe was attempted for, in order. */
  subscribed: [] as string[],
}));

vi.mock("axios", () => {
  const refuse = (name: string) => {
    const err: any = new Error(`${name} refused`);
    err.response = { status: 400, data: { error: { message: `${name} refused by provider` } } };
    return err;
  };
  const get = async (url: string) => {
    if (url.endsWith("/oauth/access_token")) return { data: { access_token: "fb_user_token", expires_in: 5184000 } };
    if (url.endsWith("/me/accounts")) return { data: { data: A.pages } };
    if (url.endsWith("/debug_token")) return { data: { data: { granular_scopes: [] } } };
    throw refuse(`unexpected GET ${url}`);
  };
  const post = async (url: string) => {
    const page = /\/([^/]+)\/subscribed_apps$/.exec(url)?.[1];
    if (page) {
      A.subscribed.push(page);
      if (A.fail.has(page)) throw refuse("page subscribe");
      return { data: { success: true } };
    }
    throw refuse(`unexpected POST ${url}`);
  };
  const axiosMock = { get, post, delete: async () => ({ data: {} }) };
  return { default: axiosMock, ...axiosMock };
});

const DB = vi.hoisted(() => ({ rows: [] as any[], seq: 0 }));
const isOp = (v: any) => v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);
/** Equality per key; `{ not }` and `{ in }` are operators; any other object is the compound unique key. */
const matches = (row: any, where: any = {}) =>
  Object.entries(where).every(([k, v]: [string, any]) => {
    if (isOp(v) && "not" in v) return row[k] !== v.not;
    if (isOp(v) && "in" in v) return v.in.includes(row[k]);
    if (isOp(v)) return Object.entries(v).every(([kk, vv]) => row[kk] === vv);
    return row[k] === v;
  });

/** Redis for getRedis(): keys and EX honoured against a clock the test moves. */
const K = vi.hoisted(() => ({
  now: 0,
  store: new Map<string, { v: string; exp: number | null; ttl: number | null }>(),
  dels: [] as string[],
  failSet: false,
}));

/** The plan's channel limit; null is unlimited. Every check is recorded. */
const L = vi.hoisted(() => ({ limit: null as number | null, calls: [] as Array<{ current: number; adding: number }> }));

const G = vi.hoisted(() => ({ user: { userId: "u_admin", tenantId: "tenant_a", role: "ADMIN" } as any }));

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: {
      channelAccount: {
        findUnique: async ({ where }: any) => DB.rows.find((r) => matches(r, where)) ?? null,
        findFirst: async ({ where }: any) => DB.rows.find((r) => matches(r, where)) ?? null,
        findMany: async ({ where }: any = {}) => DB.rows.filter((r) => matches(r, where)),
        count: async ({ where }: any = {}) => DB.rows.filter((r) => matches(r, where)).length,
        create: async ({ data }: any) => {
          if (DB.rows.some((r) => r.channel === data.channel && r.externalId === data.externalId)) {
            throw new Error("Unique constraint failed on (channel, externalId)");
          }
          const row = { id: `ca_${++DB.seq}`, lastError: null, platformMeta: null, ...data };
          DB.rows.push(row);
          return row;
        },
        update: async ({ where, data }: any) => {
          const row = DB.rows.find((r) => matches(r, where));
          if (!row) throw new Error("Record to update not found");
          Object.assign(row, data);
          return row;
        },
      },
      routerRule: { findMany: async () => [], create: async (a: any) => a.data, update: async (a: any) => a.data },
      $transaction: async (ops: any[]) => Promise.all(ops),
    },
    getRedis: () => ({
      get: async (k: string) => {
        const e = K.store.get(k);
        if (!e) return null;
        if (e.exp != null && K.now >= e.exp) {
          K.store.delete(k);
          return null;
        }
        return e.v;
      },
      set: async (k: string, v: string, ...rest: unknown[]) => {
        if (K.failSet) throw new Error("redis down");
        const i = rest.indexOf("EX");
        const ttl = i >= 0 ? Number(rest[i + 1]) : null;
        K.store.set(k, { v, exp: ttl != null ? K.now + ttl * 1000 : null, ttl });
        return "OK";
      },
      del: async (k: string) => {
        K.dels.push(k);
        return K.store.delete(k) ? 1 : 0;
      },
    }),
    authenticate: (req: any, _res: any, next: any) => { req.user = { ...G.user }; next(); },
    resolveTenant: (req: any, _res: any, next: any) => { req.tenantId = G.user.tenantId; next(); },
    resolvePrincipal: async () => ({ ...G.user }),
    requirePermission: () => (_q: any, _s: any, n: any) => n(),
    requirePermissionOrRole: () => (_q: any, _s: any, n: any) => n(),
    requireCapacity: () => (_q: any, _s: any, n: any) => n(),
    // The real rule (current + adding <= limit), the real error type, so the
    // real handleEntitlementError maps it.
    assertWithinLimit: async (_tenantId: string, limitKey: string, current: number, adding = 1) => {
      L.calls.push({ current, adding });
      if (L.limit == null || current + adding <= L.limit) return;
      throw new actual.EntitlementDeniedError({
        code: "PLAN_LIMIT_REACHED", feature: limitKey, currentPlan: "starter", limit: L.limit, current, upgradePath: "/settings/billing/plan",
      });
    },
    hasPermission: async () => true,
  };
});

import { mintOAuthState, decryptCredentials } from "@chatcenter/shared";
import router, { redesignChannelsUrl } from "../routes/channels";

const app = express();
app.use(express.json());
app.use("/api/channels", router);

const V2 = "https://dev.example.test/v2/settings/channels";
const callback = (flow?: string, who = { tenantId: "tenant_a", userId: "u_admin" }) =>
  request(app).get("/api/channels/oauth/callback").query({
    code: "code_1",
    state: mintOAuthState({ ...who, provider: "meta_channels", platform: "messenger", flow }).state,
  });
const candidates = (session: string) => request(app).get("/api/channels/messenger/candidates").query({ session });
const select = (session: string, pageIds: unknown) => request(app).post("/api/channels/messenger/select").send({ session, pageIds });
const sessionOf = (location: string) => new URL(location).searchParams.get("session")!;
const byExternal = (externalId: string) => DB.rows.find((r) => r.externalId === externalId);
const page = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `Page ${id}`, access_token: `pat_${id}`, category: "Shop", ...extra });
const row = (o: Record<string, unknown>) => ({ id: `ca_${++DB.seq}`, channel: "MESSENGER", connectionStatus: "CONNECTED", lastError: null, ...o });

/** Run the redesign callback with three Pages and return the session id. */
async function grantThree(): Promise<string> {
  A.pages = [page("pg_a"), page("pg_b"), page("pg_c")];
  const r = await callback("redesign_studio");
  return sessionOf(r.headers.location);
}

beforeEach(() => {
  DB.rows = [];
  DB.seq = 0;
  R.used.clear();
  A.pages = [];
  A.fail.clear();
  A.subscribed = [];
  K.now = 0;
  K.store.clear();
  K.dels = [];
  K.failSet = false;
  L.limit = null;
  L.calls = [];
  G.user = { userId: "u_admin", tenantId: "tenant_a", role: "ADMIN" };
});

describe("★ callback, redesign flow, more than one Page: the customer chooses", () => {
  it("lands on the picker, writes no account and subscribes nothing", async () => {
    A.pages = [page("pg_a"), page("pg_b")];
    const r = await callback("redesign_studio");
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.location);
    expect(`${loc.origin}${loc.pathname}`).toBe(V2);
    expect([...loc.searchParams.keys()]).toEqual(["pick", "platform", "session"]);
    expect(loc.searchParams.get("pick")).toBe("1");
    expect(loc.searchParams.get("platform")).toBe("messenger");
    expect(loc.searchParams.get("session")).toMatch(/^[0-9a-f-]{36}$/);
    expect(DB.rows).toEqual([]);
    expect(A.subscribed).toEqual([]);
  });

  it("the stored candidates are encrypted, tenant-keyed and expire in 900s", async () => {
    const session = await grantThree();
    const stored = K.store.get(`fb_pages:tenant_a:${session}`)!;
    expect(stored.ttl).toBe(900);
    expect(stored.v).not.toContain("pat_");
    expect(stored.v).not.toContain("Page pg_a");
    const plain = decryptCredentials(stored.v);
    expect(plain.userId).toBe("u_admin");
    expect(plain.pages.map((p: any) => p.accessToken)).toEqual(["pat_pg_a", "pat_pg_b", "pat_pg_c"]);
    expect(K.store.get("fb_pages_current:tenant_a:u_admin")?.v).toBe(session);
  });

  it("a relaunch by the same person ends their previous session", async () => {
    const first = await grantThree();
    const second = await grantThree();
    expect(second).not.toBe(first);
    expect((await candidates(first)).status).toBe(410);
    expect((await candidates(second)).status).toBe(200);
  });

  it("a session that cannot be stored lands on picker_failed, nothing connected", async () => {
    A.pages = [page("pg_a"), page("pg_b")];
    K.failSet = true;
    const r = await callback("redesign_studio");
    expect(r.headers.location).toBe(`${V2}?platform=messenger&error=picker_failed`);
    expect(DB.rows).toEqual([]);
  });
});

describe("★ callback, redesign flow, exactly one Page connects itself", () => {
  it("one Page: connected=messenger&count=1, no session", async () => {
    A.pages = [page("pg_a")];
    const r = await callback("redesign_studio");
    expect(r.headers.location).toBe(`${V2}?connected=messenger&count=1`);
    expect(byExternal("pg_a")).toMatchObject({ tenantId: "tenant_a", connectionStatus: "CONNECTED" });
    expect([...K.store.keys()].some((k) => k.startsWith("fb_pages"))).toBe(false);
  });

  it("a Page without its own token is not a choice: one usable Page still connects itself", async () => {
    A.pages = [page("pg_a"), page("pg_x", { access_token: undefined })];
    const r = await callback("redesign_studio");
    expect(r.headers.location).toBe(`${V2}?connected=messenger&count=1`);
    expect(byExternal("pg_x")).toBeUndefined();
  });

  it("★ a lone Page another workspace owns lands on already_connected, and theirs is untouched", async () => {
    DB.rows.push(row({ tenantId: "tenant_b", externalId: "pg_a", credentials: "theirs", connectedBy: "u_b" }));
    A.pages = [page("pg_a")];
    const r = await callback("redesign_studio");
    expect(r.headers.location).toBe(`${V2}?platform=messenger&error=already_connected`);
    expect(byExternal("pg_a")).toMatchObject({ tenantId: "tenant_b", credentials: "theirs", connectedBy: "u_b" });
    expect(A.subscribed).toEqual([]);
  });

  it("no plan room for the one new Page: limit_reached, nothing written", async () => {
    L.limit = 1;
    DB.rows.push(row({ tenantId: "tenant_a", channel: "GMAIL", externalId: "m@a.test" }));
    A.pages = [page("pg_a")];
    const r = await callback("redesign_studio");
    expect(r.headers.location).toBe(`${V2}?platform=messenger&error=limit_reached`);
    expect(byExternal("pg_a")).toBeUndefined();
    expect(A.subscribed).toEqual([]);
  });
});

describe("★ callback, v1 flow: still connects every Page", () => {
  it("both Pages, the old landing", async () => {
    A.pages = [page("pg_a"), page("pg_b")];
    const r = await callback();
    expect(r.headers.location).toBe("https://dev.example.test/channels?connected=messenger&count=2");
    expect(byExternal("pg_a")).toBeTruthy();
    expect(byExternal("pg_b")).toBeTruthy();
    expect(L.calls).toEqual([{ current: 0, adding: 2 }]);
  });

  it("gains the capacity check: over the limit is error=limit_reached and nothing is written", async () => {
    L.limit = 1;
    A.pages = [page("pg_a"), page("pg_b")];
    const r = await callback();
    expect(r.headers.location).toBe("https://dev.example.test/channels?error=limit_reached");
    expect(DB.rows).toEqual([]);
    expect(A.subscribed).toEqual([]);
  });

  it("★ nothing saved is no longer connected&count=0: every Page taken elsewhere is already_connected", async () => {
    DB.rows.push(row({ tenantId: "tenant_b", externalId: "pg_a" }), row({ tenantId: "tenant_b", externalId: "pg_b" }));
    A.pages = [page("pg_a"), page("pg_b")];
    const r = await callback();
    expect(r.headers.location).toBe("https://dev.example.test/channels?error=already_connected");
  });

  it("Pages none of which carry a token are no_pages, not count=0", async () => {
    A.pages = [page("pg_a", { access_token: undefined })];
    const r = await callback();
    expect(r.headers.location).toBe("https://dev.example.test/channels?error=no_pages");
  });

  it("a tenant already over its limit can still reconnect the Pages it has", async () => {
    L.limit = 1;
    DB.rows.push(
      row({ tenantId: "tenant_a", externalId: "pg_a" }),
      row({ tenantId: "tenant_a", externalId: "pg_b" }),
    );
    A.pages = [page("pg_a"), page("pg_b")];
    const r = await callback();
    expect(r.headers.location).toBe("https://dev.example.test/channels?connected=messenger&count=2");
    expect(L.calls).toEqual([]);
  });
});

describe("★ GET /messenger/candidates", () => {
  it("names, ids and standing; never a token", async () => {
    DB.rows.push(row({ tenantId: "tenant_a", externalId: "pg_a" }), row({ tenantId: "tenant_b", externalId: "pg_b" }));
    const session = await grantThree();
    const r = await candidates(session);
    expect(r.status).toBe(200);
    expect(r.body.data.pages).toEqual([
      { id: "pg_a", name: "Page pg_a", category: "Shop", connectedHere: true, takenElsewhere: false },
      { id: "pg_b", name: "Page pg_b", category: "Shop", connectedHere: false, takenElsewhere: true },
      { id: "pg_c", name: "Page pg_c", category: "Shop", connectedHere: false, takenElsewhere: false },
    ]);
    expect(Date.parse(r.body.data.expiresAt)).not.toBeNaN();
    expect(r.text).not.toContain("pat_");
    expect(r.text).not.toMatch(/access_?token/i);
  });

  it("a DISCONNECTED Page of ours is not 'connected here'", async () => {
    DB.rows.push(row({ tenantId: "tenant_a", externalId: "pg_a", connectionStatus: "DISCONNECTED" }));
    const session = await grantThree();
    const r = await candidates(session);
    expect(r.body.data.pages[0]).toMatchObject({ id: "pg_a", connectedHere: false, takenElsewhere: false });
  });

  it("★ another workspace's session is 410", async () => {
    const session = await grantThree();
    G.user = { userId: "u_admin", tenantId: "tenant_b", role: "ADMIN" };
    const r = await candidates(session);
    expect(r.status).toBe(410);
    expect(r.body).toEqual({ error: "session_expired", code: "SESSION_EXPIRED" });
  });

  it("★ another person's session in the same workspace is 410", async () => {
    const session = await grantThree();
    G.user = { userId: "u_colleague", tenantId: "tenant_a", role: "ADMIN" };
    expect((await candidates(session)).status).toBe(410);
  });

  it("past its 15 minutes, or an id never issued, is 410", async () => {
    const session = await grantThree();
    K.now += 899_000;
    expect((await candidates(session)).status).toBe(200);
    K.now += 2_000;
    expect((await candidates(session)).status).toBe(410);
    expect((await candidates("not-a-session")).status).toBe(410);
    expect((await candidates("")).status).toBe(410);
  });
});

describe("★ POST /messenger/select", () => {
  it("connects exactly the chosen Pages, each through the shared per-Page path", async () => {
    const session = await grantThree();
    const r = await select(session, ["pg_a", "pg_c"]);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      data: {
        results: [
          { id: "pg_a", name: "Page pg_a", status: "connected", subscribed: true },
          { id: "pg_c", name: "Page pg_c", status: "connected", subscribed: true },
        ],
        connected: 2,
      },
    });
    expect(byExternal("pg_b")).toBeUndefined();
    expect(A.subscribed).toEqual(["pg_a", "pg_c"]);
    const a = byExternal("pg_a");
    expect(a).toMatchObject({ tenantId: "tenant_a", connectionStatus: "CONNECTED", connectedBy: "u_admin", displayName: "Page pg_a", isActive: true });
    expect(decryptCredentials(a.credentials)).toEqual({ accessToken: "pat_pg_a", userId: "u_admin", pageId: "pg_a", pageName: "Page pg_a" });
    expect(K.dels).toEqual(expect.arrayContaining(["channel_account:MESSENGER:pg_a", "channel_account:MESSENGER:pg_c"]));
    expect(K.dels).not.toContain("channel_account:MESSENGER:pg_b");
  });

  it("★ an id the grant did not offer is 422 unknown_page; nothing written, the session still usable", async () => {
    const session = await grantThree();
    const r = await select(session, ["pg_a", "pg_zzz"]);
    expect(r.status).toBe(422);
    expect(r.body).toEqual({ error: "unknown_page", code: "UNKNOWN_PAGE", pageIds: ["pg_zzz"] });
    expect(DB.rows).toEqual([]);
    expect(A.subscribed).toEqual([]);
    expect((await select(session, ["pg_a"])).status).toBe(200);
  });

  it("an empty or missing choice is 400; duplicates connect once", async () => {
    const session = await grantThree();
    expect((await select(session, [])).status).toBe(400);
    expect((await select(session, undefined)).status).toBe(400);
    expect((await select(session, Array.from({ length: 51 }, (_, i) => `p${i}`))).status).toBe(400);
    const r = await select(session, ["pg_b", "pg_b"]);
    expect(r.status).toBe(200);
    expect(r.body.data.connected).toBe(1);
    expect(A.subscribed).toEqual(["pg_b"]);
  });

  it("★ a Page another workspace owns is reported taken and never overwritten", async () => {
    DB.rows.push(row({ tenantId: "tenant_b", externalId: "pg_b", credentials: "theirs", connectedBy: "u_b", displayName: "Theirs" }));
    const session = await grantThree();
    const r = await select(session, ["pg_a", "pg_b"]);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({
      results: [
        { id: "pg_a", name: "Page pg_a", status: "connected", subscribed: true },
        { id: "pg_b", name: "Page pg_b", status: "taken", subscribed: false },
      ],
      connected: 1,
    });
    expect(byExternal("pg_b")).toMatchObject({ tenantId: "tenant_b", credentials: "theirs", connectedBy: "u_b", displayName: "Theirs" });
    expect(A.subscribed).toEqual(["pg_a"]);
  });

  it("every chosen Page taken: 409 none_connected with the results, the session kept", async () => {
    DB.rows.push(row({ tenantId: "tenant_b", externalId: "pg_b" }));
    const session = await grantThree();
    const r = await select(session, ["pg_b"]);
    expect(r.status).toBe(409);
    expect(r.body).toEqual({
      error: "none_connected",
      code: "NONE_CONNECTED",
      data: { results: [{ id: "pg_b", name: "Page pg_b", status: "taken", subscribed: false }], connected: 0 },
    });
    expect((await select(session, ["pg_a"])).status).toBe(200);
  });

  it("★ capacity counts only NEW Pages: a reconnect needs no seat, one new Page needs one", async () => {
    // Two live channels on a plan of two: full.
    DB.rows.push(
      row({ tenantId: "tenant_a", externalId: "pg_a", credentials: "old" }),
      row({ tenantId: "tenant_a", channel: "GMAIL", externalId: "m@a.test" }),
      row({ tenantId: "tenant_b", externalId: "pg_c" }),
    );
    L.limit = 2;
    const session = await grantThree();

    const reconnectOnly = await select(session, ["pg_a", "pg_c"]);
    expect(reconnectOnly.status).toBe(200);
    expect(L.calls).toEqual([]);
    expect(reconnectOnly.body.data.results.map((x: any) => x.status)).toEqual(["reconnected", "taken"]);

    const again = await grantThree();
    const withNew = await select(again, ["pg_a", "pg_b", "pg_c"]);
    expect(withNew.status).toBe(402);
    expect(withNew.body).toMatchObject({ code: "PLAN_LIMIT_REACHED", feature: "limit:channels", limit: 2, current: 2 });
    expect(L.calls).toEqual([{ current: 2, adding: 1 }]);
    expect(byExternal("pg_b")).toBeUndefined();

    L.limit = 3;
    expect((await select(again, ["pg_a", "pg_b", "pg_c"])).status).toBe(200);
    expect(L.calls[1]).toEqual({ current: 2, adding: 1 });
    expect(byExternal("pg_b")).toMatchObject({ tenantId: "tenant_a" });
  });

  it("a DISCONNECTED Page of ours takes a seat again when it comes back", async () => {
    DB.rows.push(row({ tenantId: "tenant_a", externalId: "pg_a", connectionStatus: "DISCONNECTED" }));
    L.limit = 0;
    const session = await grantThree();
    const r = await select(session, ["pg_a"]);
    expect(r.status).toBe(402);
    expect(L.calls).toEqual([{ current: 0, adding: 1 }]);
    expect(byExternal("pg_a").connectionStatus).toBe("DISCONNECTED");
  });

  it("a reconnect refreshes the token and reports reconnected", async () => {
    DB.rows.push(row({ id: "ca_old", tenantId: "tenant_a", externalId: "pg_a", credentials: "old", connectionStatus: "ERROR", lastError: "Token is invalid or expired" }));
    const session = await grantThree();
    const r = await select(session, ["pg_a"]);
    expect(r.body.data.results).toEqual([{ id: "pg_a", name: "Page pg_a", status: "reconnected", subscribed: true }]);
    const a = byExternal("pg_a");
    expect(a).toMatchObject({ id: "ca_old", connectionStatus: "CONNECTED", lastError: null });
    expect(decryptCredentials(a.credentials).accessToken).toBe("pat_pg_a");
  });

  it("a refused subscribe is saved PENDING with SUBSCRIBE_FAILED and reported subscribed:false", async () => {
    A.fail.add("pg_b");
    const session = await grantThree();
    const r = await select(session, ["pg_a", "pg_b"]);
    expect(r.status).toBe(200);
    expect(r.body.data.results[1]).toEqual({ id: "pg_b", name: "Page pg_b", status: "connected", subscribed: false });
    expect(byExternal("pg_b").connectionStatus).toBe("PENDING");
    expect(byExternal("pg_b").lastError).toMatch(/^\[SUBSCRIBE_FAILED\] .*page subscribe refused by provider/);
    expect(byExternal("pg_a")).toMatchObject({ connectionStatus: "CONNECTED", lastError: null });
  });

  it("★ single use: a replay after success is 410 and writes nothing", async () => {
    const session = await grantThree();
    expect((await select(session, ["pg_a"])).status).toBe(200);
    expect(K.store.has(`fb_pages:tenant_a:${session}`)).toBe(false);
    const before = JSON.stringify(DB.rows);
    const replay = await select(session, ["pg_b"]);
    expect(replay.status).toBe(410);
    expect(JSON.stringify(DB.rows)).toBe(before);
    expect(byExternal("pg_b")).toBeUndefined();
  });

  it("★ another workspace or another person cannot spend the session", async () => {
    const session = await grantThree();
    G.user = { userId: "u_admin", tenantId: "tenant_b", role: "ADMIN" };
    expect((await select(session, ["pg_a"])).status).toBe(410);
    G.user = { userId: "u_colleague", tenantId: "tenant_a", role: "ADMIN" };
    expect((await select(session, ["pg_a"])).status).toBe(410);
    expect(DB.rows).toEqual([]);
    G.user = { userId: "u_admin", tenantId: "tenant_a", role: "ADMIN" };
    expect((await select(session, ["pg_a"])).status).toBe(200);
  });

  it("an expired session is 410", async () => {
    const session = await grantThree();
    K.now += 901_000;
    expect((await select(session, ["pg_a"])).status).toBe(410);
  });
});

describe("redesignChannelsUrl: the pick branch", () => {
  it("pick=1&platform=messenger&session=<id>", () => {
    expect(redesignChannelsUrl("https://o", "messenger", "pick=1&session=abc-123"))
      .toBe("https://o/v2/settings/channels?pick=1&platform=messenger&session=abc-123");
  });
  it("a pick without a session is not a pick", () => {
    expect(new URL(redesignChannelsUrl("https://o", "messenger", "pick=1")).searchParams.get("pick")).toBeNull();
  });
  it("limit_reached and picker_failed are on the closed list", () => {
    expect(new URL(redesignChannelsUrl("https://o", "messenger", "error=limit_reached")).search).toBe("?platform=messenger&error=limit_reached");
    expect(new URL(redesignChannelsUrl("https://o", "messenger", "error=picker_failed")).search).toBe("?platform=messenger&error=picker_failed");
  });
});
