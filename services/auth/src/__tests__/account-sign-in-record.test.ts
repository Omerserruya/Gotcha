/**
 * Sign in with Google: writing down the sign-in that just happened (2026-11-22).
 *
 * POST /api/account/security/sign-in is called by the app's sign-in callback,
 * once, with the new access token. Authentik signed the person in; this route
 * only records it. The rules under test:
 *
 *  - HOW the person came in is read from Authentik's newest login event, never
 *    guessed: "google" only when the event names the source their Google
 *    connection belongs to, "password" only when the password stage is named.
 *  - One audit line per sign-in, counted by the login event's id.
 *  - "Connection added" once per connection, counted by the connection's id.
 *  - The person's live setup links are marked used (they read "used" on the
 *    setup screen, not "revoked").
 *  - A NEW Google sign-in removes the one-time "set a password" token Authentik
 *    may still hold for the person.
 *  - The "connect Google" answer: "other_account" only for a Google sign-in by
 *    a different person; a password sign-in is no answer.
 *  - Nothing here can stand between a person and their session: the answer is
 *    always a 200.
 *
 * The route and the Authentik client are the real ones. Authentik is a double
 * behind `fetch`, with routes and field names read from Authentik 2026.2's own
 * source (events/signals.py on_user_logged_in, events/utils.py,
 * core/api/users.py _create_recovery_link, core/api/tokens.py).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

interface Link { id: string; userId: string; usedAt: Date | null; revokedAt: Date | null; expiresAt: Date }

const H = vi.hoisted(() => ({
  user: {} as any,
  /** GOTCHA membership rows. Dana has one in two workspaces. */
  users: {} as Record<string, { identityId: string; subject: string | null }>,
  audits: [] as any[],
  links: [] as any[],
  failAuditRead: false,
  failLinks: false,
}));

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  const inList = (cond: any, v: unknown) => (cond && Array.isArray(cond.in) ? cond.in.includes(v) : cond === v);
  return {
    ...actual,
    prisma: {
      user: {
        findUnique: vi.fn(async (a: any) => {
          const row = H.users[a.where.id];
          return row ? { id: a.where.id, identityId: row.identityId, identity: { authentikSubject: row.subject } } : null;
        }),
        findMany: vi.fn(async (a: any) =>
          Object.entries(H.users).filter(([, r]) => r.identityId === a.where.identityId).map(([id]) => ({ id }))),
      },
      auditLog: {
        // Reads the same lines writeAudit wrote, by the conditions the route gives.
        findFirst: vi.fn(async (a: any) => {
          if (H.failAuditRead) throw new Error("db down");
          const w = a.where;
          for (const k of Object.keys(w)) if (!["action", "actorId", "metadata", "createdAt"].includes(k)) throw new Error(`unexpected where.${k}`);
          return H.audits.find((r) =>
            (w.action === undefined || r.action === w.action) &&
            (w.actorId === undefined || inList(w.actorId, r.actorId)) &&
            (w.metadata === undefined || r.metadata?.[w.metadata.path[0]] === w.metadata.equals) &&
            (w.createdAt === undefined || r.createdAt >= w.createdAt.gte)) ?? null;
        }),
      },
      setupLink: {
        updateMany: vi.fn(async (a: any) => {
          if (H.failLinks) throw new Error("db down");
          const w = a.where;
          let count = 0;
          for (const l of H.links) {
            if (w.userId !== undefined && !inList(w.userId, l.userId)) continue;
            if ("usedAt" in w && l.usedAt !== w.usedAt) continue;
            if ("revokedAt" in w && l.revokedAt !== w.revokedAt) continue;
            if (w.expiresAt?.gt && !(l.expiresAt > w.expiresAt.gt)) continue;
            Object.assign(l, a.data);
            count++;
          }
          return { count };
        }),
      },
    },
    authenticate: (req: any, _res: any, next: any) => { req.user = { ...H.user }; next(); },
    writeAudit: async (a: any) => { H.audits.push({ ...a, createdAt: a.at ?? new Date() }); },
  };
});
vi.mock("../services/notification.service", () => ({ sendEmailChangeVerification: vi.fn() }));

import router from "../routes/account";
import { prisma } from "@chatcenter/shared";

const app = express();
app.use(express.json());
app.use("/api/account", router);

// ── The Authentik double ────────────────────────────────────────────────────

const DANA = { uuid: "1111aaaa2222bbbb3333cccc4444dddd", pk: 7, email: "dana@acme.com", username: "dana@acme.com", uid: "d".repeat(64) };
const NOA = { uuid: "9999eeee8888ffff7777000066661111", pk: 9, email: "noa@acme.com", username: "noa@acme.com", uid: "e".repeat(64) };
const DANA_DASHED = "1111aaaa-2222-bbbb-3333-cccc4444dddd";
/** A source's pk as the API writes it (dashes) and as an event's context holds it (bare hex). */
const GOOGLE = { slug: "google", name: "Google", pk: "3fa85f64-5717-4562-b3fc-2c963f66afa6", hex: "3fa85f6457174562b3fc2c963f66afa6" };
const OTHER = { slug: "microsoft", name: "Microsoft", pk: "0c1d2e3f-0000-4000-8000-aabbccddeeff", hex: "0c1d2e3f000040008000aabbccddeeff" };

const A = {
  people: [DANA, NOA] as any[],
  rows: [] as any[],
  events: [] as any[],
  tokens: new Set<string>(),
  failUsers: false,
  failList: false,
  failEvents: false,
  failToken: false,
  calls: [] as { method: string; path: string }[],
};

const realFetch = global.fetch;
const ok = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300, status, text: async () => (body === null ? "" : JSON.stringify(body)), json: async () => body,
}) as any;

function authentik(input: any, init: any = {}) {
  const url = new URL(String(input));
  const method = String(init.method || "GET").toUpperCase();
  const path = url.pathname.replace(/^\/api\/v3/, "");
  A.calls.push({ method, path: path + url.search });

  if (method === "GET" && path === "/core/users/") {
    if (A.failUsers) return ok({ detail: "boom" }, 500);
    return ok({ results: A.people.filter((u) => u.uuid === url.searchParams.get("uuid")) });
  }
  if (method === "GET" && path === "/sources/user_connections/all/") {
    if (A.failList) return ok({ detail: "boom" }, 500);
    const user = Number(url.searchParams.get("user"));
    return ok({ pagination: { current: 1, total_pages: 1 }, results: A.rows.filter((r) => r.user === user) });
  }
  if (method === "GET" && path === "/events/events/") {
    if (A.failEvents) return ok({ detail: "boom" }, 500);
    // Authentik's own filters: `action` is "contains", `username` matches the
    // event's user OR a username in its context (EventsFilter.filter_username).
    const action = url.searchParams.get("action") ?? "";
    const username = url.searchParams.get("username");
    const results = A.events
      .filter((e) => String(e.action).includes(action))
      .filter((e) => e.user?.username === username || e.context?.username === username)
      .sort((x, y) => String(y.created).localeCompare(String(x.created)))
      .slice(0, Number(url.searchParams.get("page_size") ?? 20));
    return ok({ pagination: { current: 1, total_pages: 1 }, results });
  }
  const tok = /^\/core\/tokens\/([^/]+)\/$/.exec(path);
  if (method === "DELETE" && tok) {
    if (A.failToken) return ok({ detail: "boom" }, 500);
    if (!A.tokens.has(tok[1])) return ok({ detail: "Not found." }, 404);
    A.tokens.delete(tok[1]);
    return ok(null, 204);
  }
  return ok({ detail: "not found" }, 404);
}

const conn = (pk: number, person = DANA, source = GOOGLE, created = "2026-11-22T07:59:30.000000Z") =>
  ({ pk, user: person.pk, source: source.pk, source_obj: { slug: source.slug, name: source.name, pk: source.pk }, identifier: `acct-${pk}`, created });
const login = (pk: string, person: typeof DANA, created: string, context: Record<string, unknown> = {}) =>
  ({ pk, action: "login", created, user: { pk: person.pk, username: person.username, email: person.email }, context });
const BY_PASSWORD = { auth_method: "password", auth_method_args: {} };
const through = (s: typeof GOOGLE, extra: Record<string, unknown> = {}) =>
  ({ source: { app: "authentik_sources_oauth", model_name: "oauthsource", pk: s.hex, name: s.name }, ...extra });

const T1 = "2026-11-22T08:00:00.000000Z";
const T2 = "2026-11-22T12:00:00.000000Z";
const resetToken = (person: typeof DANA) => `${person.uid}-password-reset`;
const called = (method: string, re: RegExp) => A.calls.filter((c) => c.method === method && re.test(c.path));
const lines = (action: string) => H.audits.filter((a) => a.action === action);
const signInLines = () => lines("auth.login_succeeded");
const addedLines = () => lines("auth.sign_in_connection_added");
const link = (id: string, userId: string, over: Partial<Link> = {}): Link =>
  ({ id, userId, usedAt: null, revokedAt: null, expiresAt: new Date(Date.now() + 3_600_000), ...over });
const linkOf = (id: string) => H.links.find((l) => l.id === id) as Link;

/** Dana signed in with Google: the connection and the login event that names its source. */
function googleSignIn(eventId = "ev-g1", at = T1, person = DANA, connPk = 31) {
  if (!A.rows.some((r) => r.pk === connPk)) A.rows.push(conn(connPk, person));
  A.events.push(login(eventId, person, at, through(GOOGLE)));
}

beforeEach(() => {
  process.env.AUTHENTIK_URL = "http://authentik-server:9000";
  process.env.AUTHENTIK_API_TOKEN = "test-token";
  process.env.AUTHENTIK_GOOGLE_SOURCE_SLUG = "google";
  H.user = { userId: "u1", tenantId: "t1", role: "AGENT", identityId: "i-dana" };
  H.users = {
    u1: { identityId: "i-dana", subject: DANA.uuid },
    u1b: { identityId: "i-dana", subject: DANA.uuid },
    u2: { identityId: "i-noa", subject: NOA.uuid },
    legacy: { identityId: "i-legacy", subject: null },
  };
  H.audits = [];
  H.links = [];
  H.failAuditRead = false;
  H.failLinks = false;
  A.people = [DANA, NOA];
  A.rows = [];
  A.events = [];
  A.tokens = new Set();
  A.failUsers = false;
  A.failList = false;
  A.failEvents = false;
  A.failToken = false;
  A.calls = [];
  global.fetch = vi.fn(async (input: any, init: any) => authentik(input, init)) as any;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

const post = (body?: unknown) => request(app).post("/api/account/security/sign-in").send(body === undefined ? {} : (body as any));
const asNoa = () => { H.user = { userId: "u2", tenantId: "t1", role: "AGENT", identityId: "i-noa" }; };

// ── How the person came in ───────────────────────────────────────────────────

describe("the method", () => {
  it("a sign-in on Authentik's own form with a password is 'password'", async () => {
    A.events = [login("ev-p1", DANA, T1, BY_PASSWORD)];
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ method: "password", google: null });
  });

  it("a sign-in through the source the person's Google connection belongs to is 'google'", async () => {
    googleSignIn();
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ method: "google", google: null });
  });

  it("Google followed by a two-step challenge is still 'google'", async () => {
    A.rows = [conn(31)];
    A.events = [login("ev-g2", DANA, T1, through(GOOGLE, { auth_method: "auth_mfa", auth_method_args: { mfa_devices: [] } }))];
    expect((await post()).body.method).toBe("google");
  });

  it("the newest sign-in decides: Google last week, a password today, is 'password'", async () => {
    googleSignIn("ev-old", "2026-11-15T08:00:00.000000Z");
    A.events.push(login("ev-new", DANA, T1, BY_PASSWORD));
    expect((await post()).body.method).toBe("password");
  });

  it("a sign-in through another source is 'unknown': not google, and never password", async () => {
    A.rows = [conn(31), conn(32, DANA, OTHER)];
    A.events = [login("ev-m1", DANA, T1, through(OTHER))];
    expect((await post()).body).toEqual({ method: "unknown", google: null });
  });

  it("a person whose only connection is to another source, signing in through it, is 'unknown'", async () => {
    A.rows = [conn(32, DANA, OTHER)];
    A.events = [login("ev-m2", DANA, T1, through(OTHER))];
    A.tokens = new Set([resetToken(DANA)]);
    expect((await post({ connectSubject: NOA.uuid })).body).toEqual({ method: "unknown", google: null });
    expect(addedLines()).toEqual([]);
    expect(A.tokens.has(resetToken(DANA))).toBe(true);
  });

  it("a source sign-in by a person with no Google connection is 'unknown'", async () => {
    A.events = [login("ev-g3", DANA, T1, through(GOOGLE))];
    expect((await post()).body.method).toBe("unknown");
  });

  it("with no Google source configured nothing is 'google', and the connections are not asked for", async () => {
    delete process.env.AUTHENTIK_GOOGLE_SOURCE_SLUG;
    googleSignIn();
    expect((await post()).body).toEqual({ method: "unknown", google: null });
    expect(called("GET", /user_connections/)).toEqual([]);
  });

  it("a source sign-in that also names the password stage is not 'password'", async () => {
    A.events = [login("ev-x1", DANA, T1, through(OTHER, BY_PASSWORD))];
    expect((await post()).body.method).toBe("unknown");
  });

  it.each([
    ["a two-step-only sign-in", { auth_method: "auth_mfa" }],
    ["a passkey sign-in", { auth_method: "auth_webauthn_pwl" }],
    ["an event that names no method", {}],
  ])("%s is 'unknown'", async (_name, context) => {
    A.events = [login("ev-u1", DANA, T1, context)];
    expect((await post()).body.method).toBe("unknown");
  });

  it("a failed attempt after the sign-in does not hide it", async () => {
    googleSignIn("ev-g4", T1);
    A.events.push({ ...login("ev-f1", DANA, T2), action: "login_failed" });
    expect((await post()).body.method).toBe("google");
  });

  it("somebody else's sign-in is never read as the caller's, even when the filter lets it through", async () => {
    // Noa typed Dana's address on a form, so her event carries Dana's username in its context.
    A.rows = [conn(31)];
    A.events = [login("ev-noa", NOA, T2, { ...BY_PASSWORD, username: DANA.username }), login("ev-g5", DANA, T1, through(GOOGLE))];
    expect((await post()).body.method).toBe("google");
  });

  it("no login event at all is 'unknown'", async () => {
    expect((await post()).body).toEqual({ method: "unknown", google: null });
  });
});

// ── The sign-in audit line ───────────────────────────────────────────────────

describe("the sign-in line", () => {
  it("is written once, under the caller, with the method and the event it counts by, dated when it happened", async () => {
    googleSignIn("ev-g1", T1);
    await post();
    expect(signInLines()).toHaveLength(1);
    expect(signInLines()[0]).toMatchObject({
      tenantId: "t1", actorType: "user", actorId: "u1", action: "auth.login_succeeded",
      targetType: "user", targetId: "u1", metadata: { method: "google", loginEventId: "ev-g1" },
    });
    expect(signInLines()[0].at).toEqual(new Date(T1));
  });

  it("a password sign-in says so", async () => {
    A.events = [login("ev-p1", DANA, T1, BY_PASSWORD)];
    await post();
    expect(signInLines().map((l) => l.metadata)).toEqual([{ method: "password", loginEventId: "ev-p1" }]);
  });

  it("the same sign-in reported again writes nothing more", async () => {
    googleSignIn("ev-g1", T1);
    await post();
    await post();
    await post();
    expect(signInLines()).toHaveLength(1);
  });

  it("the next sign-in writes the next line", async () => {
    googleSignIn("ev-g1", T1);
    await post();
    A.events.push(login("ev-p2", DANA, T2, BY_PASSWORD));
    await post();
    expect(signInLines().map((l) => l.metadata.loginEventId)).toEqual(["ev-g1", "ev-p2"]);
  });

  it("a line already written under the person's row in another workspace counts", async () => {
    googleSignIn("ev-g1", T1);
    H.audits = [{ tenantId: "t9", actorId: "u1b", action: "auth.login_succeeded", metadata: { method: "google", loginEventId: "ev-g1" }, createdAt: new Date(T1) }];
    await post();
    expect(signInLines()).toHaveLength(1);
  });

  it("another person's line does not count as the caller's", async () => {
    googleSignIn("ev-g1", T1);
    H.audits = [{ tenantId: "t1", actorId: "u2", action: "auth.login_succeeded", metadata: { method: "google", loginEventId: "ev-g1" }, createdAt: new Date(T1) }];
    await post();
    expect(signInLines().map((l) => l.actorId)).toEqual(["u2", "u1"]);
  });

  it("a different kind of line with the same event id does not count", async () => {
    googleSignIn("ev-g1", T1);
    H.audits = [{ tenantId: "t1", actorId: "u1", action: "auth.logout", metadata: { loginEventId: "ev-g1" }, createdAt: new Date(T1) }];
    await post();
    expect(signInLines()).toHaveLength(1);
  });

  it("with no login event to count by: one line, method unknown, and not another within the minute", async () => {
    await post();
    await post();
    expect(signInLines()).toHaveLength(1);
    expect(signInLines()[0].metadata).toEqual({ method: "unknown" });
    expect(signInLines()[0].at).toBeUndefined();
  });

  it("with no login event: a line older than the minute does not hold back a new one", async () => {
    H.audits = [{ tenantId: "t1", actorId: "u1", action: "auth.login_succeeded", metadata: { method: "unknown" }, createdAt: new Date(Date.now() - 61_000) }];
    await post();
    expect(signInLines()).toHaveLength(2);
  });

  it("with no login event: a line inside the minute does", async () => {
    H.audits = [{ tenantId: "t1", actorId: "u1", action: "auth.login_succeeded", metadata: { method: "unknown" }, createdAt: new Date(Date.now() - 30_000) }];
    await post();
    expect(signInLines()).toHaveLength(1);
  });

  it("a recent line for an earlier sign-in does not hold back the line for a new one", async () => {
    H.audits = [{ tenantId: "t1", actorId: "u1", action: "auth.login_succeeded", metadata: { method: "password", loginEventId: "ev-p0" }, createdAt: new Date(Date.now() - 5_000) }];
    googleSignIn("ev-g1", T1);
    await post();
    expect(signInLines().map((l) => l.metadata.loginEventId)).toEqual(["ev-p0", "ev-g1"]);
  });
});

// ── "Connection added" ───────────────────────────────────────────────────────

describe("the connection-added line", () => {
  it("is written at the first Google sign-in seen with the connection, dated when the connection was made", async () => {
    googleSignIn("ev-g1", T1);
    await post();
    expect(addedLines()).toHaveLength(1);
    expect(addedLines()[0]).toMatchObject({
      tenantId: "t1", actorType: "user", actorId: "u1", targetType: "user", targetId: "u1",
      metadata: { self: true, provider: "google", connectionId: "31" },
    });
    expect(addedLines()[0].at).toEqual(new Date("2026-11-22T07:59:30.000000Z"));
  });

  it("is not written again at the next Google sign-in with the same connection", async () => {
    googleSignIn("ev-g1", T1);
    await post();
    A.events.push(login("ev-g2", DANA, T2, through(GOOGLE)));
    await post();
    expect(signInLines()).toHaveLength(2);
    expect(addedLines()).toHaveLength(1);
  });

  it("is written again for a new connection (disconnected, then connected again)", async () => {
    googleSignIn("ev-g1", T1);
    await post();
    A.rows = [conn(44, DANA, GOOGLE, "2026-11-22T11:59:00.000000Z")];
    A.events.push(login("ev-g2", DANA, T2, through(GOOGLE)));
    await post();
    expect(addedLines().map((l) => l.metadata.connectionId)).toEqual(["31", "44"]);
  });

  it("a line written under the person's row in another workspace counts", async () => {
    H.audits = [{ tenantId: "t9", actorId: "u1b", action: "auth.sign_in_connection_added", metadata: { provider: "google", connectionId: "31" }, createdAt: new Date(T1) }];
    googleSignIn("ev-g1", T1);
    await post();
    expect(addedLines()).toHaveLength(1);
  });

  it("is not written for a password sign-in by a person who has a Google connection", async () => {
    A.rows = [conn(31)];
    A.events = [login("ev-p1", DANA, T1, BY_PASSWORD)];
    await post();
    expect(addedLines()).toEqual([]);
  });

  it("is not written for a sign-in through another source", async () => {
    A.rows = [conn(31), conn(32, DANA, OTHER)];
    A.events = [login("ev-m1", DANA, T1, through(OTHER))];
    await post();
    expect(addedLines()).toEqual([]);
  });
});

// ── Setup links ──────────────────────────────────────────────────────────────

describe("the person's setup links", () => {
  it("a live link is marked used, so the setup screen reads 'used' and not 'revoked'", async () => {
    H.links = [link("L1", "u1")];
    googleSignIn();
    await post();
    expect(linkOf("L1").usedAt).toBeInstanceOf(Date);
    expect(linkOf("L1").revokedAt).toBeNull();
  });

  it("a live link issued for the person's row in another workspace is theirs too", async () => {
    H.links = [link("L1", "u1b")];
    googleSignIn();
    await post();
    expect(linkOf("L1").usedAt).toBeInstanceOf(Date);
  });

  it("another person's link is not touched", async () => {
    H.links = [link("L1", "u1"), link("L2", "u2")];
    googleSignIn();
    await post();
    expect(linkOf("L2").usedAt).toBeNull();
  });

  it("a revoked link stays revoked and unused", async () => {
    H.links = [link("L1", "u1", { revokedAt: new Date("2026-11-21T00:00:00Z") })];
    googleSignIn();
    await post();
    expect(linkOf("L1").usedAt).toBeNull();
  });

  it("an expired link is left as it is", async () => {
    H.links = [link("L1", "u1", { expiresAt: new Date(Date.now() - 1000) })];
    googleSignIn();
    await post();
    expect(linkOf("L1").usedAt).toBeNull();
  });

  it("a link already used keeps the time of its first use", async () => {
    const first = new Date("2026-11-21T10:00:00Z");
    H.links = [link("L1", "u1", { usedAt: first })];
    googleSignIn();
    await post();
    expect(linkOf("L1").usedAt).toBe(first);
  });

  it("is done for a password sign-in as well", async () => {
    H.links = [link("L1", "u1")];
    A.events = [login("ev-p1", DANA, T1, BY_PASSWORD)];
    await post();
    expect(linkOf("L1").usedAt).toBeInstanceOf(Date);
  });
});

// ── The leftover "set a password" token ──────────────────────────────────────

describe("the one-time password token", () => {
  it("a new Google sign-in removes it", async () => {
    A.tokens = new Set([resetToken(DANA), resetToken(NOA)]);
    googleSignIn();
    const res = await post();
    expect(res.body.method).toBe("google");
    expect(called("DELETE", /tokens/).map((c) => c.path)).toEqual([`/core/tokens/${resetToken(DANA)}/`]);
    expect([...A.tokens]).toEqual([resetToken(NOA)]);
  });

  it("a password sign-in leaves it", async () => {
    A.tokens = new Set([resetToken(DANA)]);
    A.rows = [conn(31)];
    A.events = [login("ev-p1", DANA, T1, BY_PASSWORD)];
    await post();
    expect(called("DELETE", /tokens/)).toEqual([]);
    expect(A.tokens.has(resetToken(DANA))).toBe(true);
  });

  it("a sign-in through another source leaves it", async () => {
    A.tokens = new Set([resetToken(DANA)]);
    A.rows = [conn(31), conn(32, DANA, OTHER)];
    A.events = [login("ev-m1", DANA, T1, through(OTHER))];
    await post();
    expect(called("DELETE", /tokens/)).toEqual([]);
  });

  it("a Google sign-in already counted leaves a token minted after it", async () => {
    googleSignIn();
    await post();
    A.calls = [];
    A.tokens = new Set([resetToken(DANA)]); // the person asked for a password link afterwards
    const res = await post();
    expect(res.body.method).toBe("google");
    expect(called("DELETE", /tokens/)).toEqual([]);
    expect(A.tokens.has(resetToken(DANA))).toBe(true);
  });

  it("no token to remove is not a problem", async () => {
    googleSignIn();
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ method: "google", google: null });
  });

  it("a failed removal never reaches the person: same answer, same lines", async () => {
    A.tokens = new Set([resetToken(DANA)]);
    A.failToken = true;
    H.links = [link("L1", "u1")];
    googleSignIn();
    const res = await post({ connectSubject: DANA.uuid });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ method: "google", google: "connected" });
    expect(signInLines()).toHaveLength(1);
    expect(addedLines()).toHaveLength(1);
    expect(linkOf("L1").usedAt).toBeInstanceOf(Date);
  });

  it("is not attempted when Authentik gave no uid for the person", async () => {
    A.people = [{ ...DANA, uid: undefined }, NOA];
    A.tokens = new Set([resetToken(DANA)]);
    googleSignIn();
    await post();
    expect(called("DELETE", /tokens/)).toEqual([]);
  });

  it("is not attempted when the sign-in could not be counted", async () => {
    A.tokens = new Set([resetToken(DANA)]);
    H.failAuditRead = true;
    googleSignIn();
    const res = await post();
    expect(res.body.method).toBe("google");
    expect(called("DELETE", /tokens/)).toEqual([]);
  });
});

// ── The "connect Google" answer ──────────────────────────────────────────────

describe("the connect answer", () => {
  it("the same person came back through Google: connected", async () => {
    googleSignIn();
    expect((await post({ connectSubject: DANA.uuid })).body).toEqual({ method: "google", google: "connected" });
  });

  it("the same subject written with dashes is the same person", async () => {
    googleSignIn();
    expect((await post({ connectSubject: DANA_DASHED })).body.google).toBe("connected");
  });

  it("Google signed in somebody else: other_account", async () => {
    asNoa();
    googleSignIn("ev-g1", T1, NOA, 51);
    expect((await post({ connectSubject: DANA.uuid })).body).toEqual({ method: "google", google: "other_account" });
  });

  it("another person signing in with a PASSWORD is no answer (a shared machine, a connect left unfinished)", async () => {
    asNoa();
    A.rows = [conn(51, NOA)];
    A.events = [login("ev-p1", NOA, T1, BY_PASSWORD)];
    expect((await post({ connectSubject: DANA.uuid })).body).toEqual({ method: "password", google: null });
  });

  it("the same person coming back with a password did not connect anything", async () => {
    A.events = [login("ev-p1", DANA, T1, BY_PASSWORD)];
    expect((await post({ connectSubject: DANA.uuid })).body).toEqual({ method: "password", google: null });
  });

  it("an unreadable sign-in is no answer either way", async () => {
    A.failEvents = true;
    A.rows = [conn(31)];
    expect((await post({ connectSubject: DANA.uuid })).body).toEqual({ method: "unknown", google: null });
    asNoa();
    expect((await post({ connectSubject: DANA.uuid })).body).toEqual({ method: "unknown", google: null });
  });

  it.each([
    ["no body", undefined],
    ["an empty body", {}],
    ["an empty subject", { connectSubject: "" }],
    ["a blank subject", { connectSubject: "   " }],
    ["a number", { connectSubject: 7 }],
    ["a list", { connectSubject: [DANA.uuid] }],
    ["an object", { connectSubject: { $ne: null } }],
    ["a subject too long to be one", { connectSubject: "a".repeat(129) }],
  ])("a Google sign-in with %s carries no connect answer", async (_name, body) => {
    googleSignIn();
    expect((await post(body)).body).toEqual({ method: "google", google: null });
  });
});

// ── It never stands in the way ───────────────────────────────────────────────

describe("always a 200", () => {
  it("Authentik entirely down: unknown, and the GOTCHA side is still written", async () => {
    A.failUsers = true; A.failList = true; A.failEvents = true; A.failToken = true;
    H.links = [link("L1", "u1")];
    const res = await post({ connectSubject: DANA.uuid });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ method: "unknown", google: null });
    expect(signInLines().map((l) => l.metadata)).toEqual([{ method: "unknown" }]);
    expect(linkOf("L1").usedAt).toBeInstanceOf(Date);
  });

  it("the connection list down: a Google sign-in cannot be told, so it is 'unknown' and not 'password'", async () => {
    googleSignIn();
    A.failList = true;
    const res = await post({ connectSubject: NOA.uuid });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ method: "unknown", google: null });
    expect(signInLines().map((l) => l.metadata)).toEqual([{ method: "unknown", loginEventId: "ev-g1" }]);
    expect(addedLines()).toEqual([]);
  });

  it("the events read down: unknown, one line, links still marked", async () => {
    googleSignIn();
    A.failEvents = true;
    H.links = [link("L1", "u1")];
    const res = await post();
    expect(res.body).toEqual({ method: "unknown", google: null });
    expect(signInLines()).toHaveLength(1);
    expect(addedLines()).toEqual([]);
    expect(linkOf("L1").usedAt).toBeInstanceOf(Date);
  });

  it("the audit read down: the answer stands, nothing is written twice or guessed, links still marked", async () => {
    H.failAuditRead = true;
    H.links = [link("L1", "u1")];
    googleSignIn();
    const res = await post({ connectSubject: DANA.uuid });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ method: "google", google: "connected" });
    expect(H.audits).toEqual([]);
    expect(linkOf("L1").usedAt).toBeInstanceOf(Date);
  });

  it("the link write down: the answer and the lines stand", async () => {
    H.failLinks = true;
    googleSignIn();
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body.method).toBe("google");
    expect(signInLines()).toHaveLength(1);
    expect(addedLines()).toHaveLength(1);
  });

  it("a throw nobody planned for (the membership read answers nothing at all): still a 200 with what was learned", async () => {
    googleSignIn();
    (prisma.user.findMany as any).mockResolvedValueOnce(null);
    const res = await post({ connectSubject: DANA.uuid });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ method: "google", google: "connected" });
  });

  it("a member row with no identity: unknown, one line, no Authentik read", async () => {
    H.user = { userId: "legacy", tenantId: "t1", role: "AGENT", identityId: "i-legacy" };
    const res = await post({ connectSubject: DANA.uuid });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ method: "unknown", google: null });
    expect(A.calls).toEqual([]);
    expect(signInLines().map((l) => l.actorId)).toEqual(["legacy"]);
  });

  it("a service-to-service caller is not a person signing in: nothing is read or written", async () => {
    H.user = { userId: "system", tenantId: "t1", role: "ADMIN", isInternal: true };
    H.links = [link("L1", "u1")];
    const res = await post({ connectSubject: DANA.uuid });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ method: "unknown", google: null });
    expect(A.calls).toEqual([]);
    expect(H.audits).toEqual([]);
    expect(linkOf("L1").usedAt).toBeNull();
  });

  it("with no identity id on the principal, the caller's own row is still the one written and marked", async () => {
    H.user = { userId: "u1", tenantId: "t1", role: "AGENT" };
    H.links = [link("L1", "u1"), link("L2", "u1b"), link("L3", "u2")];
    googleSignIn();
    const res = await post();
    expect(res.body.method).toBe("google");
    expect(signInLines().map((l) => l.actorId)).toEqual(["u1"]);
    expect(linkOf("L1").usedAt).toBeInstanceOf(Date);
    expect(linkOf("L2").usedAt).toBeNull();
    expect(linkOf("L3").usedAt).toBeNull();
  });
});
