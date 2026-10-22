/**
 * ★ Form systems prove their credentials before CONNECTED (2026-10-09).
 *
 * fireberry, paypal, returngo, postgresql, mongodb, aws_rds and airtable (PAT)
 * were stored CONNECTED with whatever was pasted. POST /:slug/connect now runs
 * ONE read-only call first (services/connect-probe):
 *   - refused credentials: 422 validation_failed, code CREDENTIALS_INVALID
 *   - unreachable system:  422 validation_failed, code CONNECTION_FAILED
 *   - an empty required field: 400, and nothing is called
 *   - either refusal writes NOTHING, not even over a working connection
 * The real adapters run; providers are stubbed at fetch / pg / mongodb, and
 * the DB double honours `where`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.CHANNEL_ENCRYPTION_KEY = "248b2b86ff1b58bb208e102890ba28f2dd0c5c7dbc45fb81ae3d28531044ef37";
});
vi.mock("bullmq", () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock("ioredis", () => ({ default: class { on = vi.fn(); quit = vi.fn(); async get() { return null; } async set() { return "OK"; } } }));

const DB = vi.hoisted(() => ({ rows: [] as any[], seq: 0 }));
const PG = vi.hoisted(() => ({ connect: null as any, query: null as any, opts: [] as any[], ended: 0 }));
const MONGO = vi.hoisted(() => ({ connect: null as any, command: null as any, uris: [] as string[], closed: 0 }));

vi.mock("pg", () => ({
  Client: class {
    constructor(o: any) { PG.opts.push(o); }
    connect() { return PG.connect(); }
    query(sql: string) { return PG.query(sql); }
    async end() { PG.ended++; }
  },
}));
vi.mock("mongodb", () => ({
  MongoClient: class {
    constructor(uri: string) { MONGO.uris.push(uri); }
    connect() { return MONGO.connect(); }
    db() { return { command: (c: any) => MONGO.command(c) }; }
    async close() { MONGO.closed++; }
  },
}));

const matches = (row: any, where: any) => Object.entries(where ?? {}).every(([k, v]) => row[k] === v);
vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: {
      integrationCatalog: { findUnique: async (a: any) => ({ id: `cat_${a.where.slug}`, slug: a.where.slug, catalogTools: [] }) },
      // A reconnect restores missing tool rows (2026-10-10); none in this catalogue.
      tenantTool: { findMany: async () => [], createMany: async () => ({ count: 0 }) },
      tenantIntegration: {
        findFirst: async (a: any) => DB.rows.find((r) => matches(r, a.where)) ?? null,
        create: async (a: any) => {
          const { tenantTools: _t, ...data } = a.data;
          const row = { id: `ti_${++DB.seq}`, ...data };
          DB.rows.push(row);
          return row;
        },
        update: async (a: any) => {
          const row = DB.rows.find((r) => matches(r, a.where));
          if (!row) throw new Error("Record to update not found.");
          Object.assign(row, a.data);
          return row;
        },
      },
    },
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
    resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "tenant_a"; n(); },
    requireOnboardingOrActiveTenant: () => (_q: any, _s: any, n: any) => n(),
    requirePermission: () => (_q: any, _s: any, n: any) => n(),
    requirePermissionOrRole: () => (_q: any, _s: any, n: any) => n(),
    assertPublicUrl: async (u: string) => {
      if (/localhost|127\.0\.0\.1/.test(u)) throw new Error("ssrf_blocked");
      return new URL(u);
    },
  };
});

import router from "../routes/integrations";
import { probeConnectCredentials, PROBED_SLUGS } from "../services/connect-probe";

const app = express();
app.use(express.json());
app.use("/api/integrations", router);

const connect = (slug: string, body: any) => request(app).post(`/api/integrations/${slug}/connect`).send(body);
const reply = (status: number, body: any = {}) =>
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) })));
// Digits in the network error on purpose: only an "<slug>_<status>" answer is a status.
const unreachable = () => vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed: connect ECONNREFUSED 203.0.113.5:443"); }));
const fetchCalls = () => (globalThis.fetch as any).mock.calls as Array<[string, any]>;
const ours = () => DB.rows.filter((r) => r.tenantId === "tenant_a");

const HTTP: Record<string, { body: any; url: RegExp; auth: (init: any) => unknown; expectAuth: unknown; empty: any }> = {
  fireberry: {
    body: { credentials: { tokenid: "tok_1" } },
    url: /^https:\/\/api\.fireberry\.com\/api\/query$/,
    auth: (i) => i.headers.tokenid, expectAuth: "tok_1",
    empty: { credentials: { tokenid: " " } },
  },
  returngo: {
    body: { credentials: { apiKey: "rg_1", shopName: "s.myshopify.com" } },
    url: /^https:\/\/api\.returngo\.ai\/transactions\?limit=1$/,
    auth: (i) => [i.headers["x-api-key"], i.headers["x-shop-name"], i.method], expectAuth: ["rg_1", "s.myshopify.com", "GET"],
    empty: { credentials: { apiKey: "rg_1" } },
  },
  paypal: {
    body: { credentials: { clientId: "cid", clientSecret: "sec", environment: "sandbox" } },
    url: /^https:\/\/api-m\.sandbox\.paypal\.com\/v1\/oauth2\/token$/,
    auth: (i) => i.headers.Authorization, expectAuth: `Basic ${Buffer.from("cid:sec").toString("base64")}`,
    empty: { credentials: { clientId: "cid", environment: "sandbox" } },
  },
  airtable: {
    body: { credentials: { apiKey: "pat_1" } },
    url: /^https:\/\/api\.airtable\.com\/v0\/meta\/bases$/,
    auth: (i) => [i.headers.Authorization, i.method], expectAuth: ["Bearer pat_1", "GET"],
    empty: { credentials: { other: "x" } },
  },
};

beforeEach(() => {
  DB.rows = []; DB.seq = 0;
  PG.connect = async () => undefined; PG.query = async () => ({ rows: [{ "?column?": 1 }] }); PG.opts = []; PG.ended = 0;
  MONGO.connect = async () => undefined; MONGO.command = async () => ({ ok: 1 }); MONGO.uris = []; MONGO.closed = 0;
  vi.unstubAllGlobals();
});
afterEach(() => { vi.useRealTimers(); });

describe("★ HTTP form systems: one read-only call before CONNECTED", () => {
  for (const [slug, c] of Object.entries(HTTP)) {
    describe(slug, () => {
      it(`accepted credentials connect, after a real call with them`, async () => {
        reply(200, slug === "paypal" ? { access_token: "a", expires_in: 3600 } : {});
        const r = await connect(slug, c.body);
        expect(r.status).toBe(201);
        expect(ours()).toHaveLength(1);
        expect(ours()[0].status).toBe("CONNECTED");
        expect(fetchCalls()).toHaveLength(1);
        const [url, init] = fetchCalls()[0]!;
        expect(url).toMatch(c.url);
        expect(c.auth(init)).toEqual(c.expectAuth);
      });

      for (const status of [401, 403]) {
        it(`a ${status} → 422 CREDENTIALS_INVALID, nothing written, no provider text`, async () => {
          reply(status, { secret_detail: "<!DOCTYPE html>leak" });
          const r = await connect(slug, c.body);
          expect(r.status).toBe(422);
          expect(r.body).toMatchObject({ error: "validation_failed", code: "CREDENTIALS_INVALID" });
          expect(r.body.message).toMatch(/rejected these credentials/);
          expect(JSON.stringify(r.body)).not.toMatch(/leak|DOCTYPE/);
          expect(DB.rows).toEqual([]);
        });
      }

      it("an unreachable provider → 422 CONNECTION_FAILED, nothing written", async () => {
        unreachable();
        const r = await connect(slug, c.body);
        expect(r.status).toBe(422);
        expect(r.body).toMatchObject({ error: "validation_failed", code: "CONNECTION_FAILED" });
        expect(r.body.message).toMatch(/could not be reached/);
        expect(DB.rows).toEqual([]);
      });

      it("any other answer means it was reached: connects (the /test rule)", async () => {
        reply(404);
        expect((await connect(slug, c.body)).status).toBe(201);
        expect(ours()[0].status).toBe("CONNECTED");
      });

      it("an empty required field → 400, and no call is made", async () => {
        reply(200);
        const r = await connect(slug, c.empty);
        expect(r.status).toBe(400);
        expect(r.body.error).toBe("credentials required");
        expect(r.body.missingFields.length).toBeGreaterThan(0);
        expect(fetchCalls()).toHaveLength(0);
        expect(DB.rows).toEqual([]);
      });
    });
  }

  it("★ a refusal leaves an existing working connection exactly as it was", async () => {
    DB.rows.push({ id: "ti_old", tenantId: "tenant_a", integrationId: "cat_fireberry", status: "CONNECTED", credentials: "old", lastError: null });
    reply(401);
    expect((await connect("fireberry", HTTP.fireberry!.body)).status).toBe(422);
    expect(DB.rows).toEqual([{ id: "ti_old", tenantId: "tenant_a", integrationId: "cat_fireberry", status: "CONNECTED", credentials: "old", lastError: null }]);
  });

  it("another tenant's row is never the one updated", async () => {
    DB.rows.push({ id: "ti_b", tenantId: "tenant_b", integrationId: "cat_airtable", status: "CONNECTED", credentials: "theirs" });
    reply(200);
    expect((await connect("airtable", HTTP.airtable!.body)).status).toBe(201);
    expect(DB.rows.find((r) => r.id === "ti_b")).toMatchObject({ status: "CONNECTED", credentials: "theirs" });
    expect(ours()).toHaveLength(1);
  });
});

const PG_BODY = { credentials: { connectionString: "postgres://u:p@db.example.test:5432/shop" } };

describe("★ databases: connect and SELECT 1 / ping before CONNECTED", () => {
  it("postgresql: a working string connects; the client is always closed", async () => {
    const r = await connect("postgresql", PG_BODY);
    expect(r.status).toBe(201);
    expect(PG.opts[0]).toMatchObject({ connectionString: PG_BODY.credentials.connectionString, ssl: undefined });
    expect(PG.ended).toBe(1);
  });

  for (const code of ["28P01", "28000", "3D000"]) {
    it(`postgresql: ${code} → CREDENTIALS_INVALID, nothing written, no string echoed`, async () => {
      PG.connect = async () => { throw Object.assign(new Error('password authentication failed for user "u" at postgres://u:p@db'), { code }); };
      const r = await connect("postgresql", PG_BODY);
      expect(r.status).toBe(422);
      expect(r.body.code).toBe("CREDENTIALS_INVALID");
      expect(JSON.stringify(r.body)).not.toMatch(/u:p@|password authentication/);
      expect(DB.rows).toEqual([]);
      expect(PG.ended).toBe(1);
    });
  }

  it("postgresql: refused / unknown host → CONNECTION_FAILED", async () => {
    PG.connect = async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); };
    const r = await connect("postgresql", PG_BODY);
    expect(r.body).toMatchObject({ error: "validation_failed", code: "CONNECTION_FAILED" });
    expect(r.status).toBe(422);
    expect(DB.rows).toEqual([]);
  });

  it("postgresql: a failing SELECT 1 after connect is not a pass", async () => {
    PG.query = async () => { throw Object.assign(new Error("terminated"), { code: "57P01" }); };
    expect((await connect("postgresql", PG_BODY)).body.code).toBe("CONNECTION_FAILED");
    expect(DB.rows).toEqual([]);
  });

  it("mongodb: connect + ping connects; closed after", async () => {
    let pinged: any = null;
    MONGO.command = async (c: any) => { pinged = c; return { ok: 1 }; };
    const body = { credentials: { connectionString: "mongodb+srv://u:p@c.example.test" } };
    expect((await connect("mongodb", body)).status).toBe(201);
    expect(MONGO.uris).toEqual([body.credentials.connectionString]);
    expect(pinged).toEqual({ ping: 1 });
    expect(MONGO.closed).toBe(1);
  });

  it("mongodb: AuthenticationFailed → CREDENTIALS_INVALID; server selection → CONNECTION_FAILED", async () => {
    const body = { credentials: { connectionString: "mongodb://u:p@c.example.test" } };
    MONGO.connect = async () => { throw Object.assign(new Error("Authentication failed."), { code: 18, codeName: "AuthenticationFailed" }); };
    let r = await connect("mongodb", body);
    expect([r.status, r.body.code]).toEqual([422, "CREDENTIALS_INVALID"]);
    MONGO.connect = async () => { throw Object.assign(new Error("Server selection timed out"), { name: "MongoServerSelectionError" }); };
    r = await connect("mongodb", body);
    expect([r.status, r.body.code]).toEqual([422, "CONNECTION_FAILED"]);
    expect(DB.rows).toEqual([]);
  });

  it("aws_rds (postgres): probed with TLS on an RDS host", async () => {
    PG.connect = async () => { throw Object.assign(new Error("no"), { code: "28P01" }); };
    const r = await connect("aws_rds", { credentials: { connectionString: "postgres://u:p@x.abc.eu-west-1.rds.amazonaws.com:5432/db" } });
    expect([r.status, r.body.code]).toEqual([422, "CREDENTIALS_INVALID"]);
    expect(PG.opts[0].ssl).toEqual({ rejectUnauthorized: false });
    expect(DB.rows).toEqual([]);
  });

  it("aws_rds MySQL/MariaDB: mysql2 is not installed, so today's behaviour (no probe)", async () => {
    PG.connect = async () => { throw new Error("must not be called"); };
    expect((await connect("aws_rds", { credentials: { connectionString: "mysql://u:p@h/db" }, config: { engine: "mysql" } })).status).toBe(201);
    expect((await connect("aws_rds", { credentials: { connectionString: "mysql://u:p@h/db" } })).status).toBe(201);
    // The engine decides the driver at run time, whatever the string looks like.
    expect((await connect("aws_rds", { credentials: { connectionString: "postgres://u:p@h/db" }, config: { engine: "mariadb" } })).status).toBe(201);
    expect(PG.opts).toEqual([]);
  });

  it("an empty connection string → 400, no driver touched", async () => {
    for (const slug of ["postgresql", "mongodb", "aws_rds"]) {
      const r = await connect(slug, { credentials: { connectionString: "" } });
      expect(r.status).toBe(400);
      expect(r.body.missingFields).toEqual(["connectionString"]);
    }
    expect([PG.opts.length, MONGO.uris.length]).toEqual([0, 0]);
    expect(DB.rows).toEqual([]);
  });
});

describe("the probe itself", () => {
  it("covers exactly the seven form systems", () => {
    expect([...PROBED_SLUGS].sort()).toEqual(["airtable", "aws_rds", "fireberry", "mongodb", "paypal", "postgresql", "returngo"]);
  });

  it("a slug without a probe keeps today's behaviour", async () => {
    reply(200);
    const r = await connect("custom_api", { credentials: { apiKey: "k" } });
    expect(r.status).toBe(201);
    expect(ours()[0].status).toBe("CONNECTED");
    expect(fetchCalls()).toHaveLength(0);
  });

  it("a provider that never answers is CONNECTION_FAILED after the timeout", async () => {
    // Only setTimeout is faked, so the real setImmediate below can say "still
    // hanging" instead of the test itself hanging when the race is lost.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    const pending = probeConnectCredentials({ slug: "airtable", tenantId: "t", credentials: { apiKey: "pat" }, config: {} });
    await vi.advanceTimersByTimeAsync(10_000);
    const settled = await Promise.race([pending, new Promise((r) => setImmediate(() => r("still hanging")))]);
    expect(settled).toMatchObject({ ok: false, code: "CONNECTION_FAILED" });
  });
});
