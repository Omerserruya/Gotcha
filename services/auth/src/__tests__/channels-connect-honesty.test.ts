/**
 * ★ A channel connect says what will actually happen (2026-10-09).
 *
 * - A failed Messenger page / Instagram subscription keeps the account (the
 *   token is good) as PENDING with "[SUBSCRIBE_FAILED] ...", as the WhatsApp
 *   connect does; a failed Gmail watch or a missing topic keeps it CONNECTED
 *   with "[WATCH_FAILED] ..." (the daily renewal can heal only CONNECTED rows).
 * - Outlook stores its subscription's clientState, id and expiry, and never
 *   serves the clientState to a client.
 * - Starting a channel OAuth takes channels:manage:update (ADMIN still passes),
 *   and an unconfigured platform answers a machine code.
 * - A token check does not wipe a subscription gap.
 *
 * Every request goes through the real router; the OAuth state store is real
 * (signature + single use), only Redis, axios and prisma are doubled, and the
 * prisma double honours `where`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.META_APP_ID = "meta-app";
  process.env.META_APP_SECRET = "meta-secret";
  process.env.OAUTH_REDIRECT_URI = "https://dev.example.test/api/channels/oauth/callback";
  process.env.INSTAGRAM_APP_ID = "ig-app";
  process.env.INSTAGRAM_APP_SECRET = "ig-secret";
  process.env.GOOGLE_CLIENT_ID = "g-client";
  process.env.GOOGLE_CLIENT_SECRET = "g-secret";
  process.env.GOOGLE_OAUTH_REDIRECT_URI = "https://dev.example.test/api/channels/oauth/callback";
  process.env.MICROSOFT_CLIENT_ID = "ms-client";
  process.env.MICROSOFT_CLIENT_SECRET = "ms-secret";
  process.env.MICROSOFT_OAUTH_REDIRECT_URI = "https://dev.example.test/api/channels/oauth/callback";
  process.env.SLACK_CLIENT_ID = "";
  process.env.APP_PUBLIC_URL = "https://dev.example.test";
  process.env.FRONTEND_URL = "https://dev.example.test";
  process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret-0123456789abcdef";
  process.env.CHANNEL_ENCRYPTION_KEY = "248b2b86ff1b58bb208e102890ba28f2dd0c5c7dbc45fb81ae3d28531044ef37";
});

// ─── Doubles ─────────────────────────────────────────────────

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
  /** Provider calls that should fail, by a short name. */
  fail: new Set<string>(),
  /** The body Graph was sent when the subscription was created. */
  graphSubBody: null as any,
  /** What Graph answers to the subscription. */
  graphSubAnswer: { id: "sub_1", expirationDateTime: "2026-10-12T10:00:00.0000000Z" } as any,
  /** The debug_token answer for /:id/status. */
  tokenValid: true,
}));

vi.mock("axios", () => {
  const refuse = (name: string) => {
    const err: any = new Error(`${name} refused`);
    err.response = { status: 400, data: { error: { message: `${name} refused by provider` } } };
    return err;
  };
  const get = async (url: string, _cfg?: any) => {
    if (url.endsWith("/oauth/access_token")) return { data: { access_token: "fb_token", expires_in: 5184000 } };
    if (url.endsWith("/me/accounts")) {
      return { data: { data: [
        { id: "pg_ok", name: "Page OK", access_token: "pat_ok" },
        { id: "pg_bad", name: "Page Bad", access_token: "pat_bad" },
      ] } };
    }
    if (url === "https://graph.instagram.com/access_token") return { data: { access_token: "ig_long", expires_in: 5184000 } };
    if (url === "https://graph.instagram.com/me") return { data: { user_id: "ig_178", username: "acme" } };
    if (url === "https://gmail.googleapis.com/gmail/v1/users/me/profile") return { data: { emailAddress: "support@acme.test", historyId: 111 } };
    if (url === "https://graph.microsoft.com/v1.0/me") return { data: { id: "ms_me", mail: "ops@acme.test", displayName: "Ops" } };
    if (url.endsWith("/debug_token")) return { data: { data: { is_valid: A.tokenValid } } };
    throw refuse(`unexpected GET ${url}`);
  };
  const post = async (url: string, body?: any, _cfg?: any) => {
    const page = /\/(pg_[a-z]+)\/subscribed_apps$/.exec(url)?.[1];
    if (page) {
      if (A.fail.has(page)) throw refuse("page subscribe");
      return { data: { success: true } };
    }
    if (url === "https://api.instagram.com/oauth/access_token") return { data: { access_token: "ig_short", user_id: "ig_178" } };
    if (url === "https://graph.instagram.com/me/subscribed_apps") {
      if (A.fail.has("ig_sub")) throw refuse("ig subscribe");
      return { data: { success: true } };
    }
    if (url === "https://oauth2.googleapis.com/token") return { data: { access_token: "g_at", refresh_token: "g_rt", expires_in: 3600 } };
    if (url === "https://gmail.googleapis.com/gmail/v1/users/me/watch") {
      if (A.fail.has("watch")) throw refuse("watch");
      return { data: { historyId: 222, expiration: "1900000000000" } };
    }
    if (url.startsWith("https://login.microsoftonline.com/")) return { data: { access_token: "ms_at", refresh_token: "ms_rt", expires_in: 3600 } };
    if (url === "https://graph.microsoft.com/v1.0/subscriptions") {
      A.graphSubBody = body;
      if (A.fail.has("graph_sub")) throw refuse("graph subscription");
      return { data: A.graphSubAnswer };
    }
    throw refuse(`unexpected POST ${url}`);
  };
  const axiosMock = { get, post, delete: async () => ({ data: {} }) };
  return { default: axiosMock, ...axiosMock };
});

const DB = vi.hoisted(() => ({ rows: [] as any[], seq: 0 }));
/** Equality on every key of `where`; a nested object is the compound unique key. */
const matches = (row: any, where: any = {}) =>
  Object.entries(where).every(([k, v]) =>
    v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)
      ? Object.entries(v as any).every(([kk, vv]) => row[kk] === vv)
      : row[k] === v,
  );

const G = vi.hoisted(() => ({
  user: { userId: "u_admin", tenantId: "tenant_a", role: "ADMIN" } as any,
  /** "userId:permission" pairs the permission resolver grants. */
  grants: new Set<string>(),
  /** Every requirePermissionOrRole gate the router built, with its arguments. */
  gates: [] as string[][],
}));

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: {
      channelAccount: {
        findUnique: async ({ where }: any) => DB.rows.find((r) => matches(r, where)) ?? null,
        findFirst: async ({ where }: any) => DB.rows.find((r) => matches(r, where)) ?? null,
        findMany: async ({ where }: any = {}) => DB.rows.filter((r) => matches(r, where)).map((r) => ({ ...r, _count: { conversations: 0 } })),
        count: async ({ where }: any = {}) => DB.rows.filter((r) => matches(r, where)).length,
        create: async ({ data }: any) => {
          const row = { id: `ca_${++DB.seq}`, lastError: null, platformMeta: null, createdAt: new Date(), ...data };
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
    getRedis: () => ({ get: async () => null, set: async () => "OK", del: async () => 0 }),
    authenticate: (req: any, _res: any, next: any) => { req.user = { ...G.user }; next(); },
    resolveTenant: (req: any, _res: any, next: any) => { req.tenantId = G.user.tenantId; next(); },
    resolvePrincipal: async () => ({ ...G.user }),
    requirePermission: () => (_q: any, _s: any, n: any) => n(),
    // The real gate's semantics: the permission first, then SYSTEM_ADMIN or a
    // fallback role. Its resolver has its own tests; this pins the wiring.
    requirePermissionOrRole: (permission: string, ...fallbackRoles: string[]) => {
      G.gates.push([permission, ...fallbackRoles]);
      return (req: any, res: any, next: any) => {
        const u = req.user;
        if (!u) return res.status(401).json({ error: "Not authenticated" });
        if (G.grants.has(`${u.userId}:${permission}`) || u.role === "SYSTEM_ADMIN" || fallbackRoles.includes(u.role)) return next();
        return res.status(403).json({ error: "Permission denied", code: "PERMISSION_DENIED", permissions: [permission] });
      };
    },
    requireCapacity: () => (_q: any, _s: any, n: any) => n(),
    // The Messenger connect checks the plan inline since 2026-10-09; the real
    // resolver reads the database, which this suite has none of.
    assertWithinLimit: async () => {},
    validate: () => (_q: any, _s: any, n: any) => n(),
    hasPermission: async () => true,
  };
});

import { mintOAuthState } from "@chatcenter/shared";
import router from "../routes/channels";

const app = express();
app.use(express.json());
app.use("/api/channels", router);

const callback = (platform: string) =>
  request(app).get("/api/channels/oauth/callback").query({
    code: "code_1",
    state: mintOAuthState({ tenantId: "tenant_a", provider: "meta_channels", userId: "u_admin", platform }).state,
  });
const byExternal = (externalId: string) => DB.rows.find((r) => r.externalId === externalId);
const codeOf = (lastError: string | null) => /^\[([A-Z_]+)\] /.exec(lastError ?? "")?.[1] ?? null;

beforeEach(() => {
  DB.rows = [];
  DB.seq = 0;
  R.used.clear();
  A.fail.clear();
  A.graphSubBody = null;
  A.graphSubAnswer = { id: "sub_1", expirationDateTime: "2026-10-12T10:00:00.0000000Z" };
  A.tokenValid = true;
  G.user = { userId: "u_admin", tenantId: "tenant_a", role: "ADMIN" };
  G.grants.clear();
  delete process.env.GMAIL_PUBSUB_TOPIC;
  delete process.env.OUTLOOK_WEBHOOK_URL;
});

describe("★ Messenger: a page whose subscription failed is PENDING with SUBSCRIBE_FAILED", () => {
  it("per page: the refused page is PENDING with the code, the other CONNECTED with no error", async () => {
    A.fail.add("pg_bad");
    const r = await callback("messenger");
    expect(r.status).toBe(302);
    expect(byExternal("pg_ok")).toMatchObject({ connectionStatus: "CONNECTED", lastError: null });
    const bad = byExternal("pg_bad");
    expect(bad.connectionStatus).toBe("PENDING");
    expect(codeOf(bad.lastError)).toBe("SUBSCRIBE_FAILED");
    expect(bad.lastError).toContain("page subscribe refused by provider");
  });

  it("a reconnect that fails turns a CONNECTED page PENDING, and one that succeeds clears it", async () => {
    DB.rows.push({ id: "ca_old", tenantId: "tenant_a", channel: "MESSENGER", externalId: "pg_bad", connectionStatus: "CONNECTED", lastError: null, platformMeta: null });
    A.fail.add("pg_bad");
    await callback("messenger");
    expect(byExternal("pg_bad")).toMatchObject({ id: "ca_old", connectionStatus: "PENDING" });
    expect(codeOf(byExternal("pg_bad").lastError)).toBe("SUBSCRIBE_FAILED");

    A.fail.clear();
    await callback("messenger");
    expect(byExternal("pg_bad")).toMatchObject({ id: "ca_old", connectionStatus: "CONNECTED", lastError: null });
  });
});

describe("★ Instagram: a failed app subscription is PENDING with SUBSCRIBE_FAILED", () => {
  it("refused", async () => {
    A.fail.add("ig_sub");
    await callback("instagram");
    const ig = byExternal("ig_178");
    expect(ig.connectionStatus).toBe("PENDING");
    expect(codeOf(ig.lastError)).toBe("SUBSCRIBE_FAILED");
  });

  it("accepted", async () => {
    await callback("instagram");
    expect(byExternal("ig_178")).toMatchObject({ connectionStatus: "CONNECTED", lastError: null });
  });

  it("a reconnect that fails turns the existing account PENDING", async () => {
    DB.rows.push({ id: "ca_ig", tenantId: "tenant_a", channel: "INSTAGRAM", externalId: "ig_178", connectionStatus: "CONNECTED", lastError: null, platformMeta: { igLogin: true } });
    A.fail.add("ig_sub");
    await callback("instagram");
    expect(byExternal("ig_178")).toMatchObject({ id: "ca_ig", connectionStatus: "PENDING" });
    expect(codeOf(byExternal("ig_178").lastError)).toBe("SUBSCRIBE_FAILED");
  });
});

describe("★ Gmail: no topic or a failed watch is CONNECTED with WATCH_FAILED", () => {
  it("no Pub/Sub topic on this server", async () => {
    await callback("gmail");
    const g = byExternal("support@acme.test");
    expect(g.connectionStatus).toBe("CONNECTED");
    expect(codeOf(g.lastError)).toBe("WATCH_FAILED");
  });

  it("the watch refused", async () => {
    process.env.GMAIL_PUBSUB_TOPIC = "projects/p/topics/t";
    A.fail.add("watch");
    await callback("gmail");
    const g = byExternal("support@acme.test");
    expect(g.connectionStatus).toBe("CONNECTED");
    expect(codeOf(g.lastError)).toBe("WATCH_FAILED");
    expect(g.lastError).toContain("watch refused by provider");
  });

  it("a reconnect whose watch fails records WATCH_FAILED on the existing mailbox", async () => {
    process.env.GMAIL_PUBSUB_TOPIC = "projects/p/topics/t";
    DB.rows.push({ id: "ca_g", tenantId: "tenant_a", channel: "GMAIL", externalId: "support@acme.test", connectionStatus: "CONNECTED", lastError: null, platformMeta: {} });
    A.fail.add("watch");
    await callback("gmail");
    expect(byExternal("support@acme.test")).toMatchObject({ id: "ca_g", connectionStatus: "CONNECTED" });
    expect(codeOf(byExternal("support@acme.test").lastError)).toBe("WATCH_FAILED");
  });

  it("the watch armed: no error, and a reconnect clears an old one", async () => {
    process.env.GMAIL_PUBSUB_TOPIC = "projects/p/topics/t";
    DB.rows.push({ id: "ca_g", tenantId: "tenant_a", channel: "GMAIL", externalId: "support@acme.test", connectionStatus: "CONNECTED", lastError: "[WATCH_FAILED] old", platformMeta: {} });
    await callback("gmail");
    expect(byExternal("support@acme.test")).toMatchObject({ id: "ca_g", connectionStatus: "CONNECTED", lastError: null });
  });
});

describe("★ Outlook: the subscription's clientState is stored, per account", () => {
  it("stores exactly the clientState Graph was given, the id and Graph's expiry", async () => {
    process.env.OUTLOOK_WEBHOOK_URL = "https://dev.example.test/api/webhook/outlook";
    await callback("outlook");
    const o = byExternal("ops@acme.test");
    expect(A.graphSubBody.clientState).toMatch(/^[0-9a-f]{64}$/);
    expect(o.platformMeta).toEqual({
      subscriptionId: "sub_1",
      clientState: A.graphSubBody.clientState,
      subscriptionExpiresAt: "2026-10-12T10:00:00.0000000Z",
    });
    expect(o).toMatchObject({ connectionStatus: "CONNECTED", lastError: null });
  });

  it("each connect gets its own clientState", async () => {
    process.env.OUTLOOK_WEBHOOK_URL = "https://dev.example.test/api/webhook/outlook";
    await callback("outlook");
    const first = byExternal("ops@acme.test").platformMeta.clientState;
    await callback("outlook");
    const second = byExternal("ops@acme.test").platformMeta.clientState;
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
  });

  it("Graph refused: CONNECTED with OUTLOOK_SUBSCRIPTION_FAILED, and a reconnect drops the old clientState", async () => {
    process.env.OUTLOOK_WEBHOOK_URL = "https://dev.example.test/api/webhook/outlook";
    DB.rows.push({ id: "ca_o", tenantId: "tenant_a", channel: "OUTLOOK", externalId: "ops@acme.test", connectionStatus: "CONNECTED", lastError: null, platformMeta: { subscriptionId: "sub_old", clientState: "old", subscriptionExpiresAt: "x", other: 1 } });
    A.fail.add("graph_sub");
    await callback("outlook");
    const o = byExternal("ops@acme.test");
    expect(o.connectionStatus).toBe("CONNECTED");
    expect(codeOf(o.lastError)).toBe("OUTLOOK_SUBSCRIPTION_FAILED");
    expect(o.platformMeta).toEqual({ subscriptionId: null, clientState: null, subscriptionExpiresAt: null, other: 1 });
  });

  it("Graph answered without an id: a failure, nothing stored", async () => {
    process.env.OUTLOOK_WEBHOOK_URL = "https://dev.example.test/api/webhook/outlook";
    A.graphSubAnswer = { expirationDateTime: "2026-10-12T10:00:00Z" };
    await callback("outlook");
    const o = byExternal("ops@acme.test");
    expect(codeOf(o.lastError)).toBe("OUTLOOK_SUBSCRIPTION_FAILED");
    expect(o.platformMeta).toMatchObject({ subscriptionId: null, clientState: null });
  });

  it("no webhook URL on this server: OUTLOOK_SUBSCRIPTION_FAILED, Graph never asked", async () => {
    await callback("outlook");
    expect(A.graphSubBody).toBeNull();
    expect(codeOf(byExternal("ops@acme.test").lastError)).toBe("OUTLOOK_SUBSCRIPTION_FAILED");
  });

  it("the channel list never serves the clientState", async () => {
    process.env.OUTLOOK_WEBHOOK_URL = "https://dev.example.test/api/webhook/outlook";
    await callback("outlook");
    const list = (await request(app).get("/api/channels")).body.data;
    const o = list.find((c: any) => c.externalId === "ops@acme.test");
    expect(o.platformMeta).toEqual({ subscriptionId: "sub_1", subscriptionExpiresAt: "2026-10-12T10:00:00.0000000Z" });
    expect(JSON.stringify(list)).not.toContain(byExternal("ops@acme.test").platformMeta.clientState);
  });
});

describe("★ the reads split the new codes", () => {
  it("/channels and /channels/state serve lastErrorCode for a refused subscription", async () => {
    A.fail.add("pg_bad");
    await callback("messenger");
    const list = (await request(app).get("/api/channels")).body.data;
    const state = (await request(app).get("/api/channels/state")).body.data;
    for (const rows of [list, state]) {
      const bad = rows.find((c: any) => c.id === byExternal("pg_bad").id);
      expect(bad.lastErrorCode).toBe("SUBSCRIBE_FAILED");
      expect(bad.lastError).not.toMatch(/^\[/);
    }
  });
});

describe("★ starting a channel OAuth takes channels:manage:update", () => {
  it("the router builds the gate with that permission and ADMIN as the fallback", () => {
    expect(G.gates).toContainEqual(["channels:manage:update", "ADMIN"]);
  });

  it.each([
    ["init-url", () => request(app).get("/api/channels/oauth/init-url?platform=gmail")],
    ["init (redirect)", () => request(app).get("/api/channels/oauth/init?platform=gmail&token=t")],
  ])("%s: an AGENT holding the permission starts it", async (_name, go) => {
    G.user = { userId: "u_agent", tenantId: "tenant_a", role: "AGENT" };
    G.grants.add("u_agent:channels:manage:update");
    const r = await go();
    expect([200, 302]).toContain(r.status);
    const url = r.body?.url ?? r.headers.location;
    expect(new URL(url).host).toBe("accounts.google.com");
  });

  it.each([
    ["init-url", () => request(app).get("/api/channels/oauth/init-url?platform=gmail")],
    ["init (redirect)", () => request(app).get("/api/channels/oauth/init?platform=gmail&token=t")],
  ])("%s: an AGENT without it is refused, 403", async (_name, go) => {
    G.user = { userId: "u_agent", tenantId: "tenant_a", role: "AGENT" };
    G.grants.add("u_agent:channels:manage:read");
    const r = await go();
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("PERMISSION_DENIED");
  });

  it.each([
    ["init-url", () => request(app).get("/api/channels/oauth/init-url?platform=gmail")],
    ["init (redirect)", () => request(app).get("/api/channels/oauth/init?platform=gmail&token=t")],
  ])("%s: an ADMIN with no resolved permission still starts it", async (_name, go) => {
    const r = await go();
    expect([200, 302]).toContain(r.status);
  });
});

describe("★ NOT_CONFIGURED: the init-url answer carries a machine code", () => {
  it("409, the old error word, the code, the platform", async () => {
    const r = await request(app).get("/api/channels/oauth/init-url?platform=slack");
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "not_configured", code: "NOT_CONFIGURED", platform: "slack" });
  });
});

describe("★ a token check does not wipe a subscription gap", () => {
  it("a valid token keeps a PENDING page PENDING with its SUBSCRIBE_FAILED", async () => {
    const lastError = "[SUBSCRIBE_FAILED] Messenger page subscription failed, so messages cannot arrive: x";
    DB.rows.push({ id: "ca_p", tenantId: "tenant_a", channel: "MESSENGER", externalId: "pg_x", connectionStatus: "PENDING", lastError, credentials: { accessToken: "pat" } });
    const r = await request(app).get("/api/channels/ca_p/status");
    expect(r.body.data.status).toBe("PENDING");
    expect(byExternal("pg_x")).toMatchObject({ connectionStatus: "PENDING", lastError });
  });

  it("a valid token still clears any other error", async () => {
    DB.rows.push({ id: "ca_e", tenantId: "tenant_a", channel: "MESSENGER", externalId: "pg_y", connectionStatus: "ERROR", lastError: "Token is invalid or expired", credentials: { accessToken: "pat" } });
    await request(app).get("/api/channels/ca_e/status");
    expect(byExternal("pg_y")).toMatchObject({ connectionStatus: "CONNECTED", lastError: null });
  });

  it("an invalid token is still ERROR, even on a gap", async () => {
    A.tokenValid = false;
    DB.rows.push({ id: "ca_q", tenantId: "tenant_a", channel: "MESSENGER", externalId: "pg_z", connectionStatus: "PENDING", lastError: "[SUBSCRIBE_FAILED] x", credentials: { accessToken: "pat" } });
    await request(app).get("/api/channels/ca_q/status");
    expect(byExternal("pg_z")).toMatchObject({ connectionStatus: "ERROR", lastError: "Token is invalid or expired" });
  });

  it("another tenant's row is not found", async () => {
    DB.rows.push({ id: "ca_t", tenantId: "tenant_b", channel: "MESSENGER", externalId: "pg_t", connectionStatus: "PENDING", lastError: "[SUBSCRIBE_FAILED] x", credentials: { accessToken: "pat" } });
    expect((await request(app).get("/api/channels/ca_t/status")).status).toBe(404);
  });
});


describe("★ a subscribe failure lands as connected-but-pending, in the redesign only (2026-10-10)", () => {
  const redesign = (platform: string) =>
    request(app).get("/api/channels/oauth/callback").query({
      code: "code_1",
      state: mintOAuthState({ tenantId: "tenant_a", provider: "meta_channels", userId: "u_admin", platform, flow: "redesign_studio" }).state,
    });
  const query = (r: any) => new URL(r.headers.location, "https://x.test").searchParams;

  it("Instagram refused: pending=1, platform and reason=SUBSCRIBE_FAILED", async () => {
    A.fail.add("ig_sub");
    const q = query(await redesign("instagram"));
    expect(q.get("pending")).toBe("1");
    expect(q.get("platform")).toBe("instagram");
    expect(q.get("reason")).toBe("SUBSCRIBE_FAILED");
    expect(q.get("connected")).toBe("instagram");
  });

  it("Instagram accepted: a plain connected landing", async () => {
    const q = query(await redesign("instagram"));
    expect(q.get("pending")).toBeNull();
    expect(q.get("reason")).toBeNull();
  });

  it("v1 keeps its old landing even when the subscription failed", async () => {
    A.fail.add("ig_sub");
    const r = await callback("instagram");
    expect(r.headers.location).not.toMatch(/reason=|pending=/);
  });
});

describe("★ Outlook: a mailbox owned by another workspace is refused BEFORE any Graph subscription (2026-10-10)", () => {
  it("no subscription is created for a refused connect", async () => {
    process.env.OUTLOOK_WEBHOOK_URL = "https://dev.example.test/api/webhook/outlook";
    DB.rows.push({ id: "ca_other", tenantId: "tenant_b", channel: "OUTLOOK", externalId: "ops@acme.test", connectionStatus: "CONNECTED", lastError: null, platformMeta: {} });
    const r = await callback("outlook");
    expect(r.headers.location).toMatch(/already_connected/);
    expect(A.graphSubBody).toBeNull();
  });
});
