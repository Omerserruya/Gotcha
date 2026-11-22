/**
 * A changed email and the Google connection (2026-11-22).
 *
 * Authentik connects a Google account to a person by matching the email at the
 * first Google sign-in. So the connection belongs to the OLD address. Left in
 * place after the address changes, the old address's Google account would
 * still open this person's account. Two rules follow, and both are under test:
 *
 *  1. a confirmed email change removes the Google connection, and removes it
 *     BEFORE anything else changes, so a failure half way leaves the person a
 *     password and no stale connection;
 *  2. the change is refused while no usable password can be proven, because
 *     removing the connection would then lock the person out. Every doubt
 *     (policy not set up, IdP failing, an answer that is not a plain yes) is
 *     "no password".
 *
 * A person with no Google connection is not touched at all, and with the
 * feature off (no source slug) Authentik is not even asked.
 *
 * The routes and the Authentik client are the real ones; Authentik is a double
 * behind `fetch`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  caller: { userId: "u1", tenantId: "t1", role: "AGENT" } as any,
  users: [] as any[],
  identities: [] as any[],
  audits: [] as any[],
  mails: [] as { to: string; url: string }[],
  /** Every write, in the order it happened, here and in Authentik. */
  events: [] as string[],
}));

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  const withIdentity = (u: any) => (u ? { ...u, identity: H.identities.find((i) => i.id === u.identityId) ?? null } : null);
  return {
    ...actual,
    prisma: {
      user: {
        findUnique: async ({ where }: any) => withIdentity(H.users.find((u) => u.id === where.id)),
        findMany: async ({ where }: any) => H.users.filter((u) => u.identityId === where.identityId),
        findFirst: async ({ where }: any) =>
          H.users.find((u) => where.tenantId.in.includes(u.tenantId) && u.email === where.email && u.identityId !== where.identityId.not) ?? null,
        updateMany: async ({ where, data }: any) => {
          for (const u of H.users) if (u.identityId === where.identityId) Object.assign(u, data);
        },
      },
      identity: {
        findFirst: async ({ where }: any) => H.identities.find((i) => i.email === where.email && i.id !== where.id.not) ?? null,
        update: async ({ where, data }: any) => {
          H.events.push(`db:email=${data.email}`);
          Object.assign(H.identities.find((i) => i.id === where.id), data);
        },
      },
      $transaction: async (ops: any[]) => Promise.all(ops),
    },
    withCrossTenantAccess: async (fn: any) => fn(),
    authenticate: (req: any, _res: any, next: any) => { req.user = { ...H.caller }; next(); },
    writeAudit: async (a: any) => { H.audits.push(a); },
    resolveAppPublicUrl: () => "https://app.example.test",
  };
});
vi.mock("../services/notification.service", () => ({
  sendEmailChangeVerification: async (to: string, _name: string, url: string) => { H.mails.push({ to, url }); },
}));

import router from "../routes/account";

const app = express();
app.use(express.json());
app.use("/api/account", router);

// ── The Authentik double ────────────────────────────────────────────────────

const GOOGLE = { slug: "google", name: "Google", pk: "aaaa" };
const OTHER = { slug: "microsoft", name: "Microsoft", pk: "bbbb" };
interface Row { pk: number; user: number; source_obj: typeof GOOGLE; identifier: string; created: string }

const A = {
  users: [] as { uuid: string; pk: number; email: string; username: string }[],
  rows: [] as Row[],
  /** userPk -> what the usable-password policy answers for that user. */
  password: {} as Record<number, unknown>,
  failUsers: false,
  failList: false,
  failPolicy: false,
  failDelete: false,
  failPatch: false,
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
    if (A.failUsers) return ok({ detail: "boom" }, 500);
    return ok({ results: A.users.filter((u) => u.uuid === url.searchParams.get("uuid")) });
  }
  if (method === "GET" && path === "/sources/user_connections/all/") {
    if (A.failList) return ok({ detail: "boom" }, 500);
    const user = Number(url.searchParams.get("user"));
    return ok({ pagination: { current: 1, total_pages: 1 }, results: A.rows.filter((r) => r.user === user) });
  }
  const del = /^\/sources\/user_connections\/oauth\/(\d+)\/$/.exec(path);
  if (method === "DELETE" && del) {
    if (A.failDelete) return ok({ detail: "boom" }, 500);
    H.events.push(`idp:disconnect ${del[1]}`);
    A.rows = A.rows.filter((r) => r.pk !== Number(del[1]));
    return ok(null, 204);
  }
  const test = /^\/policies\/all\/([^/]+)\/test\/$/.exec(path);
  if (method === "POST" && test) {
    if (A.failPolicy) return ok({ detail: "boom" }, 500);
    return ok({ passing: A.password[body.user], messages: [], log_messages: [] });
  }
  const patch = /^\/core\/users\/(\d+)\/$/.exec(path);
  if (method === "PATCH" && patch) {
    if (A.failPatch) return ok({ detail: "boom" }, 500);
    H.events.push(`idp:email=${body.email}`);
    Object.assign(A.users.find((u) => u.pk === Number(patch[1]))!, body);
    return ok({}, 200);
  }
  return ok({ detail: "not found" }, 404);
}

const conn = (pk: number, user: number, source = GOOGLE): Row =>
  ({ pk, user, source_obj: source, identifier: `acct-${pk}`, created: "2026-11-20T09:15:00.000000Z" });
const asked = (re: RegExp) => A.calls.filter((c) => re.test(c.path)).length;
const actions = () => H.audits.map((a) => a.action);

const DANA = 7, NOA = 9;

beforeEach(() => {
  process.env.AUTHENTIK_URL = "http://authentik-server:9000";
  process.env.AUTHENTIK_API_TOKEN = "test-token";
  process.env.AUTHENTIK_GOOGLE_SOURCE_SLUG = "google";
  process.env.AUTHENTIK_USABLE_PASSWORD_POLICY_PK = "pol-1";
  process.env.OAUTH_STATE_SECRET = "s".repeat(40);
  H.caller = { userId: "u1", tenantId: "t1", role: "AGENT" };
  H.identities = [
    { id: "i1", email: "dana@acme.com", authentikSubject: "sub-dana" },
    { id: "i2", email: "noa@acme.com", authentikSubject: "sub-noa" },
    { id: "i3", email: "old@acme.com", authentikSubject: null },
  ];
  H.users = [
    { id: "u1", tenantId: "t1", email: "dana@acme.com", name: "Dana", identityId: "i1" },
    { id: "u2", tenantId: "t1", email: "noa@acme.com", name: "Noa", identityId: "i2" },
    { id: "u3", tenantId: "t1", email: "old@acme.com", name: "Old", identityId: "i3" },
  ];
  H.audits = [];
  H.mails = [];
  H.events = [];
  A.users = [
    { uuid: "sub-dana", pk: DANA, email: "dana@acme.com", username: "dana@acme.com" },
    { uuid: "sub-noa", pk: NOA, email: "noa@acme.com", username: "noa@acme.com" },
  ];
  A.rows = [];
  A.password = {};
  A.failUsers = false;
  A.failList = false;
  A.failPolicy = false;
  A.failDelete = false;
  A.failPatch = false;
  A.calls = [];
  global.fetch = vi.fn(async (input: any, init: any) => authentik(input, init)) as any;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

const ask = (newEmail = "dana.new@acme.com") => request(app).post("/api/account/email-change").send({ newEmail });
const confirm = (token: string) => request(app).post("/api/account/email-change/verify").send({ token });

/** A valid link for the caller, minted with the feature off so nothing can refuse it. */
async function link(newEmail = "dana.new@acme.com"): Promise<string> {
  const slug = process.env.AUTHENTIK_GOOGLE_SOURCE_SLUG;
  delete process.env.AUTHENTIK_GOOGLE_SOURCE_SLUG;
  const r = await ask(newEmail);
  if (slug !== undefined) process.env.AUTHENTIK_GOOGLE_SOURCE_SLUG = slug;
  expect(r.status).toBe(200);
  const token = new URL(H.mails[H.mails.length - 1].url).searchParams.get("token")!;
  H.mails = []; H.audits = []; H.events = []; A.calls = [];
  return token;
}

/** The ways "is there a usable password" can fail to be a proven yes. */
const NOT_PROVEN: [string, () => void][] = [
  ["the policy says no", () => { A.password[DANA] = false; }],
  ["the policy is not set up", () => { A.password[DANA] = true; delete process.env.AUTHENTIK_USABLE_PASSWORD_POLICY_PK; }],
  ["the policy pk is blank", () => { A.password[DANA] = true; process.env.AUTHENTIK_USABLE_PASSWORD_POLICY_PK = "  "; }],
  ["the policy read fails", () => { A.password[DANA] = true; A.failPolicy = true; }],
  ["the policy answers the word \"true\"", () => { A.password[DANA] = "true"; }],
  ["the policy answers 1", () => { A.password[DANA] = 1; }],
  ["the policy answers nothing", () => { /* undefined */ }],
];

const unchanged = () => {
  expect(H.identities[0].email).toBe("dana@acme.com");
  expect(H.users[0].email).toBe("dana@acme.com");
  expect(A.users[0].email).toBe("dana@acme.com");
  expect(H.events.filter((e) => e.includes("email="))).toEqual([]);
};

describe("asking for the change: refused before a link is mailed", () => {
  it.each(NOT_PROVEN)("Google connected and %s: 409 no_other_sign_in, no mail, no audit line", async (_name, arrange) => {
    A.rows = [conn(31, DANA)];
    arrange();
    const r = await ask();
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "no_other_sign_in" });
    expect(H.mails).toEqual([]);
    expect(H.audits).toEqual([]);
    expect(A.rows).toHaveLength(1);
  });

  it("a connection to another source is not a password: still refused", async () => {
    A.rows = [conn(31, DANA), conn(32, DANA, OTHER)];
    A.password[DANA] = false;
    expect((await ask()).status).toBe(409);
    expect(H.mails).toEqual([]);
  });

  it("Google connected and a password: the link is mailed, and nothing is removed yet", async () => {
    A.rows = [conn(31, DANA)];
    A.password[DANA] = true;
    const r = await ask();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ sent: true });
    expect(H.mails.map((m) => m.to)).toEqual(["dana.new@acme.com"]);
    expect(A.rows).toHaveLength(1);
    expect(H.events).toEqual([]);
    expect(actions()).toEqual(["auth.email_change_requested"]);
  });

  it.each([
    ["no connection and no password (invited, never signed in)", () => { A.password[DANA] = false; }],
    ["no connection and the policy not set up", () => { delete process.env.AUTHENTIK_USABLE_PASSWORD_POLICY_PK; }],
    ["only a connection to another source", () => { A.rows = [conn(32, DANA, OTHER)]; A.password[DANA] = false; }],
    ["somebody else's Google connection", () => { A.rows = [conn(33, NOA)]; A.password[DANA] = false; }],
  ])("%s: not touched, the link is mailed", async (_name, arrange) => {
    arrange();
    expect((await ask()).status).toBe(200);
    expect(H.mails).toHaveLength(1);
  });

  it("with no Google connection the password is not even asked about", async () => {
    await ask();
    expect(asked(/policies/)).toBe(0);
  });

  it.each([
    ["the connections cannot be read", () => { A.failList = true; }],
    ["the person is not in Authentik", () => { A.users = []; }],
    ["Authentik cannot be read at all", () => { A.failUsers = true; }],
  ])("%s: not a refusal here, confirming asks again", async (_name, arrange) => {
    A.rows = [conn(31, DANA)];
    A.password[DANA] = false;
    arrange();
    expect((await ask()).status).toBe(200);
    expect(H.mails).toHaveLength(1);
  });

  it("a person with no Authentik identity is not asked about", async () => {
    H.caller = { userId: "u3", tenantId: "t1", role: "AGENT" };
    expect((await ask("old.new@acme.com")).status).toBe(200);
    expect(A.calls).toEqual([]);
  });

  it.each([[undefined], [""], ["   "]])("feature off (slug %j): Authentik is not asked, a Google-only person is not refused", async (slug) => {
    if (slug === undefined) delete process.env.AUTHENTIK_GOOGLE_SOURCE_SLUG; else process.env.AUTHENTIK_GOOGLE_SOURCE_SLUG = slug;
    A.rows = [conn(31, DANA)];
    A.password[DANA] = false;
    expect((await ask()).status).toBe(200);
    expect(A.calls).toEqual([]);
  });

  it("the earlier refusals still come first: a taken address is email_taken, and Authentik is not asked", async () => {
    A.rows = [conn(31, DANA)];
    A.password[DANA] = false;
    const r = await ask("noa@acme.com");
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "email_taken" });
    expect(A.calls).toEqual([]);
  });
});

describe("confirming the change: the Google connection goes, and goes first", () => {
  it("Google connected and a password: removed, then the email moves here, then in Authentik", async () => {
    const token = await link();
    A.rows = [conn(31, DANA)];
    A.password[DANA] = true;
    const r = await confirm(token);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, email: "dana.new@acme.com", googleDisconnected: true });
    expect(H.events).toEqual(["idp:disconnect 31", "db:email=dana.new@acme.com", "idp:email=dana.new@acme.com"]);
    expect(A.rows).toEqual([]);
    expect(H.identities[0].email).toBe("dana.new@acme.com");
    expect(H.users[0].email).toBe("dana.new@acme.com");
    expect(A.users[0]).toMatchObject({ email: "dana.new@acme.com", username: "dana.new@acme.com" });
  });

  it("two audit lines: the connection removed (why), and the change confirmed (saying so)", async () => {
    const token = await link();
    A.rows = [conn(31, DANA)];
    A.password[DANA] = true;
    await confirm(token);
    expect(H.audits).toEqual([
      {
        tenantId: "t1", actorType: "user", actorId: "u1", action: "auth.sign_in_connection_removed",
        targetType: "user", targetId: "u1", metadata: { self: true, provider: "google", reason: "email_change" },
      },
      {
        tenantId: "t1", actorType: "user", actorId: "u1", action: "auth.email_change_confirmed",
        targetType: "user", targetId: "u1", metadata: { self: true, from: "dana@acme.com", to: "dana.new@acme.com", googleDisconnected: true },
      },
    ]);
  });

  it("only the caller's Google connection goes: another source's and another person's stay", async () => {
    const token = await link();
    A.rows = [conn(32, DANA, OTHER), conn(31, DANA), conn(33, NOA)];
    A.password[DANA] = true;
    await confirm(token);
    expect(A.rows.map((r) => r.pk)).toEqual([32, 33]);
    expect(H.events.filter((e) => e.startsWith("idp:disconnect"))).toEqual(["idp:disconnect 31"]);
  });

  it("no Google connection: the change goes through as before, and says nothing was disconnected", async () => {
    const token = await link();
    A.password[DANA] = false;
    const r = await confirm(token);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, email: "dana.new@acme.com", googleDisconnected: false });
    expect(H.events).toEqual(["db:email=dana.new@acme.com", "idp:email=dana.new@acme.com"]);
    expect(H.audits).toHaveLength(1);
    expect(H.audits[0].metadata).toEqual({ self: true, from: "dana@acme.com", to: "dana.new@acme.com" });
    expect(asked(/policies/)).toBe(0);
  });

  it.each([
    ["only a connection to another source", () => { A.rows = [conn(32, DANA, OTHER)]; }],
    ["somebody else's Google connection", () => { A.rows = [conn(33, NOA)]; }],
  ])("%s, no password: not touched, nothing removed", async (_name, arrange) => {
    const token = await link();
    arrange();
    A.password[DANA] = false;
    const before = A.rows.length;
    const r = await confirm(token);
    expect(r.status).toBe(200);
    expect(r.body.googleDisconnected).toBe(false);
    expect(A.rows).toHaveLength(before);
  });
});

describe("confirming the change: refused while no usable password can be proven", () => {
  it.each(NOT_PROVEN)("Google connected and %s: 409 no_other_sign_in, and nothing changed anywhere", async (_name, arrange) => {
    const token = await link();
    A.rows = [conn(31, DANA)];
    arrange();
    const r = await confirm(token);
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "no_other_sign_in" });
    unchanged();
    expect(A.rows.map((x) => x.pk)).toEqual([31]);
    expect(H.events).toEqual([]);
    expect(H.audits).toEqual([]);
  });

  it("a connection to another source is not a password: refused, both connections stay", async () => {
    const token = await link();
    A.rows = [conn(31, DANA), conn(32, DANA, OTHER)];
    A.password[DANA] = false;
    expect((await confirm(token)).status).toBe(409);
    expect(A.rows).toHaveLength(2);
    unchanged();
  });

  it("a link mailed while there was a password is still refused once there is none", async () => {
    A.rows = [conn(31, DANA)];
    A.password[DANA] = true;
    expect((await ask()).status).toBe(200);
    const token = new URL(H.mails[0].url).searchParams.get("token")!;
    A.password[DANA] = false;
    expect((await confirm(token)).status).toBe(409);
    unchanged();
    expect(A.rows).toHaveLength(1);
  });
});

describe("confirming the change: a failure never leaves a half change behind", () => {
  it("the connections cannot be read: 502, nothing changed (not read as 'no connection')", async () => {
    const token = await link();
    A.rows = [conn(31, DANA)];
    A.password[DANA] = true;
    A.failList = true;
    const r = await confirm(token);
    expect(r.status).toBe(502);
    expect(r.body).toEqual({ error: "idp_sync_failed" });
    unchanged();
    expect(A.rows).toHaveLength(1);
    expect(H.audits).toEqual([]);
  });

  it("Authentik cannot be read at all: 502, nothing changed", async () => {
    const token = await link();
    A.rows = [conn(31, DANA)];
    A.password[DANA] = true;
    A.failUsers = true;
    const r = await confirm(token);
    expect(r.status).toBe(502);
    expect(r.body).toEqual({ error: "idp_sync_failed" });
    expect(H.identities[0].email).toBe("dana@acme.com");
    expect(H.events).toEqual([]);
    expect(A.rows).toHaveLength(1);
  });

  it("the connection cannot be removed: 502, the email does not move and no line is written", async () => {
    const token = await link();
    A.rows = [conn(31, DANA)];
    A.password[DANA] = true;
    A.failDelete = true;
    const r = await confirm(token);
    expect(r.status).toBe(502);
    expect(r.body).toEqual({ error: "idp_sync_failed" });
    unchanged();
    expect(A.rows).toHaveLength(1);
    expect(H.audits).toEqual([]);
  });

  it("Authentik refuses the new email after the connection went: rolled back here, and the answer says Google was disconnected", async () => {
    const token = await link();
    A.rows = [conn(31, DANA)];
    A.password[DANA] = true;
    A.failPatch = true;
    const r = await confirm(token);
    expect(r.status).toBe(502);
    expect(r.body).toEqual({ error: "idp_sync_failed", googleDisconnected: true });
    expect(H.identities[0].email).toBe("dana@acme.com");
    expect(H.users[0].email).toBe("dana@acme.com");
    expect(A.users[0].email).toBe("dana@acme.com");
    expect(A.rows).toEqual([]);
    expect(actions()).toEqual(["auth.sign_in_connection_removed"]);
  });

  it("Authentik refuses the new email and there was no connection: the answer is as it always was", async () => {
    const token = await link();
    A.failPatch = true;
    const r = await confirm(token);
    expect(r.status).toBe(502);
    expect(r.body).toEqual({ error: "idp_sync_failed" });
    expect(H.identities[0].email).toBe("dana@acme.com");
  });
});

describe("confirming the change: what was true before still is", () => {
  it.each([[undefined], [""], ["   "]])("feature off (slug %j): the connection is not read and not removed", async (slug) => {
    const token = await link();
    if (slug === undefined) delete process.env.AUTHENTIK_GOOGLE_SOURCE_SLUG; else process.env.AUTHENTIK_GOOGLE_SOURCE_SLUG = slug;
    A.rows = [conn(31, DANA)];
    A.password[DANA] = false;
    const r = await confirm(token);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, email: "dana.new@acme.com", googleDisconnected: false });
    expect(A.rows).toHaveLength(1);
    expect(asked(/user_connections|policies/)).toBe(0);
  });

  it("a taken address is refused before the connection is looked at", async () => {
    const token = await link("free@acme.com");
    H.identities.push({ id: "i9", email: "free@acme.com", authentikSubject: "sub-x" });
    A.rows = [conn(31, DANA)];
    A.password[DANA] = true;
    const r = await confirm(token);
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "email_taken" });
    expect(A.rows).toHaveLength(1);
    expect(A.calls).toEqual([]);
  });

  it("somebody else's link is refused before the connection is looked at", async () => {
    const token = await link();
    H.caller = { userId: "u2", tenantId: "t1", role: "AGENT" };
    A.rows = [conn(31, DANA), conn(33, NOA)];
    A.password[DANA] = true;
    A.password[NOA] = true;
    expect((await confirm(token)).status).toBe(403);
    expect(A.rows).toHaveLength(2);
    expect(A.calls).toEqual([]);
  });

  it("a person Authentik does not know (their subject finds nobody): no connection to lose, the change goes through here", async () => {
    const token = await link();
    A.users = [];
    A.rows = [conn(31, DANA)];
    const r = await confirm(token);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, email: "dana.new@acme.com", googleDisconnected: false });
    expect(H.identities[0].email).toBe("dana.new@acme.com");
    expect(asked(/user_connections|policies/)).toBe(0);
  });

  it("a person with no Authentik identity: the change goes through, Authentik is not asked", async () => {
    H.caller = { userId: "u3", tenantId: "t1", role: "AGENT" };
    const token = await link("old.new@acme.com");
    const r = await confirm(token);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, email: "old.new@acme.com", googleDisconnected: false });
    expect(A.calls).toEqual([]);
  });
});
