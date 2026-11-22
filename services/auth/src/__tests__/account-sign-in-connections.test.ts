/**
 * Sign in with Google: what a signed-in person sees of their own connection,
 * and the one rule on removing it (2026-11-22).
 *
 * Authentik makes the connection (an exact email match at the first Google
 * sign-in). These routes only read it and remove it. The rule under test: a
 * connection is never removed when it is the person's only way in, and every
 * doubt about "is there another way in" is answered "no".
 *
 * The routes and the Authentik client are the real ones. Authentik itself is a
 * double behind `fetch`, with the routes and field names read from Authentik
 * 2026.2's own source: /sources/user_connections/all/?user=<pk>,
 * DELETE /sources/user_connections/oauth/<pk>/, POST /policies/all/<pk>/test/.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  user: { userId: "u1", tenantId: "t1", role: "AGENT" } as any,
  /** GOTCHA membership rows: id -> the identity's Authentik subject. */
  subjects: { u1: "sub-dana", u2: "sub-noa", legacy: null } as Record<string, string | null>,
  audits: [] as any[],
}));

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: {
      user: {
        findUnique: vi.fn(async (a: any) => {
          const id = a.where.id;
          if (!(id in H.subjects)) return null;
          return { id, identityId: `i-${id}`, identity: { authentikSubject: H.subjects[id] } };
        }),
      },
    },
    authenticate: (req: any, _res: any, next: any) => { req.user = { ...H.user }; next(); },
    writeAudit: async (a: any) => { H.audits.push(a); },
  };
});
vi.mock("../services/notification.service", () => ({ sendEmailChangeVerification: vi.fn() }));

import router from "../routes/account";

const app = express();
app.use(express.json());
app.use("/api/account", router);

// ── The Authentik double ────────────────────────────────────────────────────

const DANA = { uuid: "sub-dana", pk: 7, email: "dana@acme.com", username: "dana@acme.com" };
const NOA = { uuid: "sub-noa", pk: 9, email: "noa@acme.com", username: "noa@acme.com" };
const GOOGLE = { slug: "google", name: "Google", pk: "aaaa" };
const OTHER = { slug: "microsoft", name: "Microsoft", pk: "bbbb" };

interface Row { pk: number; user: number; source_obj: typeof GOOGLE; identifier: string; created: string }

const A = {
  rows: [] as Row[],
  /** userPk -> what the usable-password policy answers for that user. */
  password: {} as Record<number, unknown>,
  /** A server that ignores `?user=` and answers with everybody's rows. */
  ignoresUserFilter: false,
  failList: false,
  failPolicy: false,
  failDelete: false,
  calls: [] as { method: string; path: string; body: any }[],
};

const realFetch = global.fetch;
const ok = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300, status, text: async () => (body === null ? "" : JSON.stringify(body)), json: async () => body,
}) as any;

function authentik(input: any, init: any = {}) {
  const url = new URL(String(input));
  const method = String(init.method || "GET").toUpperCase();
  const path = url.pathname.replace(/^\/api\/v3/, "");
  const body = init.body ? JSON.parse(init.body) : null;
  A.calls.push({ method, path: path + url.search, body });

  if (method === "GET" && path === "/core/users/") {
    const uuid = url.searchParams.get("uuid");
    return ok({ results: [DANA, NOA].filter((u) => u.uuid === uuid) });
  }
  if (method === "GET" && path === "/sources/user_connections/all/") {
    if (A.failList) return ok({ detail: "boom" }, 500);
    const user = Number(url.searchParams.get("user"));
    const results = A.rows.filter((r) => A.ignoresUserFilter || r.user === user);
    return ok({ pagination: { current: 1, total_pages: 1 }, results });
  }
  const del = /^\/sources\/user_connections\/oauth\/(\d+)\/$/.exec(path);
  if (method === "DELETE" && del) {
    if (A.failDelete) return ok({ detail: "boom" }, 500);
    A.rows = A.rows.filter((r) => r.pk !== Number(del[1]));
    return ok(null, 204);
  }
  const test = /^\/policies\/all\/([^/]+)\/test\/$/.exec(path);
  if (method === "POST" && test) {
    if (A.failPolicy) return ok({ detail: "boom" }, 500);
    return ok({ passing: A.password[body.user], messages: [], log_messages: [] });
  }
  return ok({ detail: "not found" }, 404);
}

const conn = (pk: number, user: number, source = GOOGLE, created = "2026-11-20T09:15:00.000000Z"): Row =>
  ({ pk, user, source_obj: source, identifier: `acct-${pk}`, created });

const called = (method: string, re: RegExp) => A.calls.filter((c) => c.method === method && re.test(c.path));
const deletes = () => called("DELETE", /user_connections/).map((c) => c.path);

beforeEach(() => {
  process.env.AUTHENTIK_URL = "http://authentik-server:9000";
  process.env.AUTHENTIK_API_TOKEN = "test-token";
  process.env.AUTHENTIK_GOOGLE_SOURCE_SLUG = "google";
  process.env.AUTHENTIK_USABLE_PASSWORD_POLICY_PK = "pol-1";
  H.user = { userId: "u1", tenantId: "t1", role: "AGENT" };
  H.audits = [];
  A.rows = [];
  A.password = {};
  A.ignoresUserFilter = false;
  A.failList = false;
  A.failPolicy = false;
  A.failDelete = false;
  A.calls = [];
  global.fetch = vi.fn(async (input: any, init: any) => authentik(input, init)) as any;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

const get = () => request(app).get("/api/account/sign-in-connections");
const disconnect = () => request(app).delete("/api/account/sign-in-connections/google");

const OFF = { available: false, connected: false, email: null, connectedAt: null, canDisconnect: false, reason: null };

// ── GET ─────────────────────────────────────────────────────────────────────

describe("GET /api/account/sign-in-connections", () => {
  it("says Google is not available when no source is configured, and asks Authentik nothing", async () => {
    delete process.env.AUTHENTIK_GOOGLE_SOURCE_SLUG;
    A.rows = [conn(31, DANA.pk)];
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ google: OFF });
    expect(A.calls).toEqual([]);
  });

  it("a blank source name is the same as none", async () => {
    process.env.AUTHENTIK_GOOGLE_SOURCE_SLUG = "   ";
    const res = await get();
    expect(res.body).toEqual({ google: OFF });
  });

  it("a person with no connection: available, not connected, nothing to remove", async () => {
    A.password[DANA.pk] = true;
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ google: { ...OFF, available: true } });
    // Nothing to remove, so the password question is not asked at all.
    expect(called("POST", /policies/)).toEqual([]);
  });

  it("connected, with a password: can be removed", async () => {
    A.rows = [conn(31, DANA.pk)];
    A.password[DANA.pk] = true;
    const res = await get();
    expect(res.body).toEqual({
      google: {
        available: true, connected: true, email: "dana@acme.com",
        connectedAt: "2026-11-20T09:15:00.000000Z", canDisconnect: true, reason: null,
      },
    });
  });

  it("connected, with no password: cannot be removed, and says why", async () => {
    A.rows = [conn(31, DANA.pk)];
    A.password[DANA.pk] = false;
    const res = await get();
    expect(res.body.google).toMatchObject({ connected: true, canDisconnect: false, reason: "no_other_sign_in" });
  });

  it("asks the configured policy about the caller and nobody else", async () => {
    A.rows = [conn(31, DANA.pk)];
    A.password[DANA.pk] = false;
    A.password[NOA.pk] = true;
    const res = await get();
    expect(res.body.google.canDisconnect).toBe(false);
    const asked = called("POST", /policies/);
    expect(asked).toHaveLength(1);
    expect(asked[0].path).toBe("/policies/all/pol-1/test/");
    expect(asked[0].body).toEqual({ user: DANA.pk });
  });

  for (const [name, arrange] of [
    ["the policy is not configured", () => { delete process.env.AUTHENTIK_USABLE_PASSWORD_POLICY_PK; }],
    ["the policy read fails", () => { A.failPolicy = true; }],
    ["the policy answers something that is not yes or no", () => { A.password[DANA.pk] = "true"; }],
    ["the policy answers nothing", () => { delete A.password[DANA.pk]; }],
  ] as [string, () => void][]) {
    it(`when ${name}, the connection cannot be removed`, async () => {
      A.rows = [conn(31, DANA.pk)];
      A.password[DANA.pk] = true;
      arrange();
      const res = await get();
      expect(res.status).toBe(200);
      expect(res.body.google).toMatchObject({ connected: true, canDisconnect: false, reason: "no_other_sign_in" });
    });
  }

  it("an unconfigured policy is never asked", async () => {
    delete process.env.AUTHENTIK_USABLE_PASSWORD_POLICY_PK;
    A.rows = [conn(31, DANA.pk)];
    await get();
    expect(called("POST", /policies/)).toEqual([]);
  });

  it("no password but a connection to another source: can be removed", async () => {
    A.rows = [conn(31, DANA.pk), conn(32, DANA.pk, OTHER)];
    A.password[DANA.pk] = false;
    const res = await get();
    expect(res.body.google).toMatchObject({ connected: true, canDisconnect: true, reason: null });
  });

  it("a connection to another source only is not a Google connection", async () => {
    A.rows = [conn(32, DANA.pk, OTHER)];
    A.password[DANA.pk] = true;
    const res = await get();
    expect(res.body).toEqual({ google: { ...OFF, available: true } });
  });

  it("another person's Google connection is not the caller's, even from a server that ignores the filter", async () => {
    A.rows = [conn(40, NOA.pk)];
    A.ignoresUserFilter = true;
    A.password[DANA.pk] = true;
    const res = await get();
    expect(res.body).toEqual({ google: { ...OFF, available: true } });
  });

  it("another person's connection does not count as the caller's other way in", async () => {
    A.rows = [conn(31, DANA.pk), conn(41, NOA.pk, OTHER)];
    A.ignoresUserFilter = true;
    A.password[DANA.pk] = false;
    const res = await get();
    expect(res.body.google).toMatchObject({ connected: true, canDisconnect: false, reason: "no_other_sign_in" });
  });

  it("a membership with no identity behind it: 409 no_identity", async () => {
    H.user = { userId: "legacy", tenantId: "t1", role: "AGENT" };
    const res = await get();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "no_identity" });
  });

  it("an identity Authentik does not know: 409 no_identity", async () => {
    H.subjects.ghost = "sub-ghost";
    H.user = { userId: "ghost", tenantId: "t1", role: "AGENT" };
    const res = await get();
    expect(res.status).toBe(409);
    delete H.subjects.ghost;
  });

  it("a failed read is 502, never 'not connected'", async () => {
    A.rows = [conn(31, DANA.pk)];
    A.failList = true;
    const res = await get();
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "idp_unavailable" });
  });
});

// ── DELETE ──────────────────────────────────────────────────────────────────

describe("DELETE /api/account/sign-in-connections/google", () => {
  it("removes the caller's Google connection when they have a password, and records it", async () => {
    A.rows = [conn(31, DANA.pk), conn(40, NOA.pk)];
    A.password[DANA.pk] = true;
    const res = await disconnect();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(deletes()).toEqual(["/sources/user_connections/oauth/31/"]);
    expect(A.rows.map((r) => r.pk)).toEqual([40]);
    expect(H.audits).toEqual([{
      tenantId: "t1", actorType: "user", actorId: "u1",
      action: "auth.sign_in_connection_removed", targetType: "user", targetId: "u1",
      metadata: { self: true, provider: "google" },
    }]);
  });

  it("refuses when Google is the only way in, and removes nothing", async () => {
    A.rows = [conn(31, DANA.pk)];
    A.password[DANA.pk] = false;
    const res = await disconnect();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "no_other_sign_in" });
    expect(deletes()).toEqual([]);
    expect(A.rows.map((r) => r.pk)).toEqual([31]);
    expect(H.audits).toEqual([]);
  });

  for (const [name, arrange] of [
    ["the policy is not configured", () => { delete process.env.AUTHENTIK_USABLE_PASSWORD_POLICY_PK; }],
    ["the policy read fails", () => { A.failPolicy = true; }],
    ["the policy answers something that is not yes or no", () => { A.password[DANA.pk] = 1; }],
  ] as [string, () => void][]) {
    it(`refuses when ${name}`, async () => {
      A.rows = [conn(31, DANA.pk)];
      A.password[DANA.pk] = true;
      arrange();
      const res = await disconnect();
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "no_other_sign_in" });
      expect(deletes()).toEqual([]);
      expect(H.audits).toEqual([]);
    });
  }

  it("another person's password does not unlock the caller's connection", async () => {
    A.rows = [conn(31, DANA.pk)];
    A.password[DANA.pk] = false;
    A.password[NOA.pk] = true;
    const res = await disconnect();
    expect(res.status).toBe(409);
    expect(deletes()).toEqual([]);
  });

  it("no password but another source connected: removes Google and only Google", async () => {
    A.rows = [conn(31, DANA.pk), conn(32, DANA.pk, OTHER)];
    A.password[DANA.pk] = false;
    const res = await disconnect();
    expect(res.status).toBe(200);
    expect(deletes()).toEqual(["/sources/user_connections/oauth/31/"]);
    expect(A.rows.map((r) => r.pk)).toEqual([32]);
  });

  it("nothing to remove: 404 not_connected", async () => {
    A.password[DANA.pk] = true;
    const res = await disconnect();
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_connected" });
    expect(deletes()).toEqual([]);
    expect(H.audits).toEqual([]);
  });

  it("a connection to another source is not removed by the Google route", async () => {
    A.rows = [conn(32, DANA.pk, OTHER)];
    A.password[DANA.pk] = true;
    const res = await disconnect();
    expect(res.status).toBe(404);
    expect(A.rows.map((r) => r.pk)).toEqual([32]);
  });

  it("never removes another person's connection, even from a server that ignores the filter", async () => {
    A.rows = [conn(40, NOA.pk)];
    A.ignoresUserFilter = true;
    A.password[DANA.pk] = true;
    const res = await disconnect();
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_connected" });
    expect(deletes()).toEqual([]);
    expect(A.rows.map((r) => r.pk)).toEqual([40]);
  });

  it("with the filter ignored and both people connected, it is the caller's row that goes", async () => {
    A.rows = [conn(40, NOA.pk), conn(31, DANA.pk)];
    A.ignoresUserFilter = true;
    A.password[DANA.pk] = true;
    const res = await disconnect();
    expect(res.status).toBe(200);
    expect(deletes()).toEqual(["/sources/user_connections/oauth/31/"]);
    expect(A.rows.map((r) => r.pk)).toEqual([40]);
  });

  it("Google not configured: 404 not_available, and Authentik is not touched", async () => {
    delete process.env.AUTHENTIK_GOOGLE_SOURCE_SLUG;
    A.rows = [conn(31, DANA.pk)];
    A.password[DANA.pk] = true;
    const res = await disconnect();
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_available" });
    expect(A.calls).toEqual([]);
  });

  it("a membership with no identity behind it: 409 no_identity", async () => {
    H.user = { userId: "legacy", tenantId: "t1", role: "AGENT" };
    const res = await disconnect();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "no_identity" });
  });

  it("a failed read is 502 and removes nothing", async () => {
    A.rows = [conn(31, DANA.pk)];
    A.password[DANA.pk] = true;
    A.failList = true;
    const res = await disconnect();
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "idp_unavailable" });
    expect(deletes()).toEqual([]);
  });

  it("a failed removal is 502 and is not recorded as done", async () => {
    A.rows = [conn(31, DANA.pk)];
    A.password[DANA.pk] = true;
    A.failDelete = true;
    const res = await disconnect();
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "idp_unavailable" });
    expect(A.rows.map((r) => r.pk)).toEqual([31]);
    expect(H.audits).toEqual([]);
  });
});
