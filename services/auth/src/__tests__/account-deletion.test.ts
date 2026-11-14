/**
 * Account deletion requests (Google Play / App Store, 2026-11-14). Contract:
 * release-next-kit/account-deletion/CONTRACT.md, agreed with Frontend.
 * Real service and routes; the database, Redis, mail and the GDPR erasure are
 * doubles. Nothing is deleted until an operator completes a confirmed request.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import crypto from "crypto";

const H = vi.hoisted(() => ({
  identities: [] as any[],
  users: [] as any[],
  rows: [] as any[],
  redis: new Map<string, { n: number; ttl: number }>(),
  mails: [] as any[],
  erased: [] as any[],
  user: { userId: "u1" } as any,
  refusal: null as any,
  seq: 0,
}));

const match = (r: any, w: any = {}) => Object.entries(w).every(([k, v]: any) => {
  if (v && typeof v === "object" && !(v instanceof Date)) {
    if ("in" in v) return v.in.includes(r[k]);
    if ("not" in v) return r[k] !== v.not;
  }
  return r[k] === v;
});

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  const prisma = {
    identity: { findUnique: vi.fn(async (a: any) => H.identities.find((i) => i.email === a.where.email) ?? null) },
    user: {
      findUnique: vi.fn(async (a: any) => {
        const u = H.users.find((x) => x.id === a.where.id);
        return u ? { ...u, identity: H.identities.find((i) => i.id === u.identityId) } : null;
      }),
      findMany: vi.fn(async (a: any) => H.users.filter((u) => match(u, a.where)).map((u) => ({ ...u, tenant: { name: `ws-${u.tenantId}` } }))),
      count: vi.fn(async (a: any) => H.users.filter((u) => match(u, a.where)).length),
    },
    accountDeletionRequest: {
      findFirst: vi.fn(async (a: any) => [...H.rows].reverse().find((r) => match(r, a.where)) ?? null),
      findUnique: vi.fn(async (a: any) => H.rows.find((r) => match(r, a.where)) ?? null),
      findMany: vi.fn(async (a: any) => H.rows.filter((r) => match(r, a.where))),
      create: vi.fn(async (a: any) => {
        const now = new Date();
        const row = { id: `adr${++H.seq}`, status: "PENDING_VERIFICATION", createdAt: now, updatedAt: now, verifiedAt: null, ...a.data };
        H.rows.push(row); return row;
      }),
      update: vi.fn(async (a: any) => Object.assign(H.rows.find((r) => r.id === a.where.id), a.data, { updatedAt: new Date() })),
      updateMany: vi.fn(async (a: any) => {
        const hits = H.rows.filter((r) => match(r, a.where));
        hits.forEach((r) => Object.assign(r, a.data, { updatedAt: new Date() }));
        return { count: hits.length };
      }),
    },
  };
  const getRedis = () => ({
    incr: async (k: string) => { const e = H.redis.get(k) ?? { n: 0, ttl: -1 }; e.n++; H.redis.set(k, e); return e.n; },
    expire: async (k: string, s: number) => { H.redis.get(k)!.ttl = s; return 1; },
    ttl: async (k: string) => H.redis.get(k)?.ttl ?? -2,
  });
  return {
    ...actual, prisma, getRedis,
    withCrossTenantAccess: async (fn: () => any) => fn(),
    resolveAppPublicUrl: () => "https://dev.gotcha.co.il",
    authenticate: (req: any, _res: any, next: any) => { req.user = { ...H.user }; next(); },
    requireSystemAdmin: () => (req: any, res: any, next: any) => (req.user?.role === "SYSTEM_ADMIN" ? next() : res.status(403).json({ error: "forbidden" })),
  };
});
vi.mock("../services/notification.service", () => ({
  sendAccountDeletionConfirmEmail: vi.fn(async (to: string, _n: string, url: string, locale: string) => { H.mails.push({ kind: "confirm", to, url, locale }); }),
  sendAccountDeletionNoticeEmail: vi.fn(async (to: string) => { H.mails.push({ kind: "notice", to }); }),
}));
vi.mock("../services/gdpr.service", () => ({
  eraseUser: vi.fn(async (tenantId: string, userId: string) => { H.erased.push({ kind: "user", tenantId, userId }); return { deleted: true, identityDeleted: false }; }),
  eraseTenant: vi.fn(async (tenantId: string) => { H.erased.push({ kind: "tenant", tenantId }); return { counts: {} }; }),
  tenantDeletionRefusal: vi.fn(async () => H.refusal),
}));

import routes, { operatorRouter } from "../routes/account-deletion";
import { TOKEN_TTL_MS } from "../services/account-deletion.service";

const app = () => {
  const a = express(); a.use(express.json());
  a.use("/api/auth/account-deletion", routes); a.use("/api/system", operatorRouter); return a;
};
const ask = (body: any, ip = "1.2.3.4") => request(app()).post("/api/auth/account-deletion/request").set("X-Real-IP", ip).send(body);
const confirmWith = (token: string) => request(app()).post("/api/auth/account-deletion/confirm").send({ token });
const tokenOf = (mail: any) => new URL(mail.url).searchParams.get("token")!;

beforeEach(() => {
  vi.clearAllMocks();
  H.identities = [{ id: "id_dana", email: "dana@aviv.co.il", name: "Dana" }];
  H.users = [{ id: "u1", tenantId: "t1", identityId: "id_dana", role: "AGENT" }, { id: "u_admin", tenantId: "t1", identityId: "id_other", role: "ADMIN" }];
  H.rows = []; H.redis.clear(); H.mails = []; H.erased = []; H.refusal = null; H.seq = 0;
  H.user = { userId: "u1" };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("★ public request: the same answer for everyone, mail only to a real account", () => {
  it("★ an existing account: 202 accepted, one PENDING row, a confirmation mail to that address with a 24h link on the product origin", async () => {
    const r = await ask({ email: " Dana@Aviv.co.il ", workspace: "Aviv", locale: "he" });
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ data: { accepted: true } });
    expect(H.rows).toHaveLength(1);
    expect(H.rows[0]).toMatchObject({ email: "dana@aviv.co.il", source: "public", identityId: "id_dana", status: "PENDING_VERIFICATION", workspaceName: "Aviv" });
    expect(H.mails).toEqual([expect.objectContaining({ kind: "confirm", to: "dana@aviv.co.il", locale: "he" })]);
    expect(H.mails[0].url).toMatch(/^https:\/\/dev\.gotcha\.co\.il\/he\/account-deletion\/confirm\?token=/);
    const ttl = H.rows[0].tokenExpiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(TOKEN_TTL_MS - 5000);
    expect(TOKEN_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("★ the token is stored only as its sha256", async () => {
    await ask({ email: "dana@aviv.co.il", locale: "en" });
    const token = tokenOf(H.mails[0]);
    expect(JSON.stringify(H.rows)).not.toContain(token);
    expect(H.rows[0].tokenHash).toBe(crypto.createHash("sha256").update(token).digest("hex"));
  });

  it("★ no account: the identical 202, and no row, no mail (a stranger's address is never stored or mailed)", async () => {
    const r = await ask({ email: "nobody@example.com", locale: "he" });
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ data: { accepted: true } });
    expect(H.rows).toHaveLength(0);
    expect(H.mails).toHaveLength(0);
  });

  it("a bad address: 400 BAD_EMAIL", async () => {
    for (const email of ["", "not-an-email", "a@b", 42, "x".repeat(250) + "@a.co"]) {
      const r = await ask({ email });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe("BAD_EMAIL");
    }
  });

  it("one resend per 15 minutes: a second ask right away sends nothing new", async () => {
    await ask({ email: "dana@aviv.co.il" });
    await ask({ email: "dana@aviv.co.il" });
    expect(H.mails).toHaveLength(1);
    expect(H.rows).toHaveLength(1);
  });

  it("★ limits: the 4th ask for one address in a day is 429 RATE_LIMITED with Retry-After", async () => {
    for (let i = 0; i < 3; i++) expect((await ask({ email: "dana@aviv.co.il" }, `10.0.0.${i}`)).status).toBe(202);
    const r = await ask({ email: "dana@aviv.co.il" }, "10.0.0.9");
    expect(r.status).toBe(429);
    expect(r.body.code).toBe("RATE_LIMITED");
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("limits: the 6th ask from one IP in an hour is 429, whatever the address", async () => {
    for (let i = 0; i < 5; i++) expect((await ask({ email: `p${i}@example.com` }, "9.9.9.9")).status).toBe(202);
    expect((await ask({ email: "p6@example.com" }, "9.9.9.9")).status).toBe(429);
  });
});

describe("★ confirm: only the person's POST spends the token, and it deletes nothing", () => {
  it("★ 200 scheduled, deleteBy 30 days on, the address masked; the row is VERIFIED; nothing erased", async () => {
    await ask({ email: "dana@aviv.co.il" });
    const r = await confirmWith(tokenOf(H.mails[0]));
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe("scheduled");
    expect(r.body.data.email).toBe("d***@aviv.co.il");
    const days = (new Date(r.body.data.deleteBy).getTime() - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    expect(H.rows[0].status).toBe("VERIFIED");
    expect(H.erased).toHaveLength(0);
  });

  it("a second confirm: 409 ALREADY_CONFIRMED", async () => {
    await ask({ email: "dana@aviv.co.il" });
    const t = tokenOf(H.mails[0]);
    await confirmWith(t);
    const r = await confirmWith(t);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("ALREADY_CONFIRMED");
  });

  it("an expired token: 410 TOKEN_EXPIRED, the row EXPIRED", async () => {
    await ask({ email: "dana@aviv.co.il" });
    H.rows[0].tokenExpiresAt = new Date(Date.now() - 1000);
    const r = await confirmWith(tokenOf(H.mails[0]));
    expect(r.status).toBe(410);
    expect(r.body.code).toBe("TOKEN_EXPIRED");
    expect(H.rows[0].status).toBe("EXPIRED");
  });

  it("an unknown or malformed token: 400 BAD_TOKEN", async () => {
    expect((await confirmWith("x".repeat(43))).body.code).toBe("BAD_TOKEN");
    expect((await confirmWith("short")).status).toBe(400);
  });

  it("there is no GET that confirms (mail scanners open links)", async () => {
    await ask({ email: "dana@aviv.co.il" });
    const r = await request(app()).get(`/api/auth/account-deletion/confirm?token=${tokenOf(H.mails[0])}`);
    expect(r.status).toBe(404);
    expect(H.rows[0].status).toBe("PENDING_VERIFICATION");
  });
});

describe("in-app (signed in)", () => {
  it("POST /me: VERIFIED at once, a notice mail; GET /me shows it; a second POST is 409; DELETE cancels", async () => {
    const r = await request(app()).post("/api/auth/account-deletion/me").send({ reason: "closing the shop" });
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe("VERIFIED");
    expect(H.rows[0]).toMatchObject({ source: "in_app", userId: "u1", tenantId: "t1", identityId: "id_dana", reason: "closing the shop" });
    expect(H.mails).toEqual([{ kind: "notice", to: "dana@aviv.co.il" }]);
    expect((await request(app()).get("/api/auth/account-deletion/me")).body.data.id).toBe(H.rows[0].id);
    expect((await request(app()).post("/api/auth/account-deletion/me").send({})).status).toBe(409);
    expect((await request(app()).delete("/api/auth/account-deletion/me")).status).toBe(200);
    expect(H.rows[0].status).toBe("CANCELLED");
    expect((await request(app()).get("/api/auth/account-deletion/me")).body.data).toBeNull();
  });
});

describe("★ operator completes through the GDPR erasure, and refuses rather than guess", () => {
  const op = () => { H.user = { userId: "op1", role: "SYSTEM_ADMIN" }; };
  const verified = (o: any = {}) => { H.rows.push({ id: "adr1", email: "dana@aviv.co.il", identityId: "id_dana", status: "VERIFIED", createdAt: new Date(), updatedAt: new Date(), ...o }); };
  const completeIt = (body: any = {}) => request(app()).post("/api/system/account-deletion-requests/adr1/complete").send(body);

  it("★ a member of a shared workspace: eraseUser for that membership (it removes the Authentik identity on the last one), COMPLETED", async () => {
    op(); verified();
    const r = await completeIt();
    expect(r.status).toBe(200);
    expect(H.erased).toEqual([{ kind: "user", tenantId: "t1", userId: "u1" }]);
    expect(H.rows[0]).toMatchObject({ status: "COMPLETED", completedBy: "op1" });
  });

  it("not an operator: 403", async () => {
    verified();
    expect((await completeIt()).status).toBe(403);
    expect(H.erased).toHaveLength(0);
  });

  it("not confirmed yet: 409 NOT_VERIFIED", async () => {
    op(); verified({ status: "PENDING_VERIFICATION" });
    expect((await completeIt()).body.code).toBe("NOT_VERIFIED");
    expect(H.erased).toHaveLength(0);
  });

  it("★ the only admin of a workspace with other members: 409 LAST_OWNER, nothing erased", async () => {
    op(); verified();
    H.users = [{ id: "u1", tenantId: "t1", identityId: "id_dana", role: "ADMIN" }, { id: "u2", tenantId: "t1", identityId: "id_x", role: "AGENT" }];
    const r = await completeIt();
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("LAST_OWNER");
    expect(r.body.workspaces).toEqual([{ tenantId: "t1", name: "ws-t1" }]);
    expect(H.erased).toHaveLength(0);
  });

  it("★ a workspace with only this person: 409 SOLE_MEMBER_WORKSPACE unless the operator names it; then eraseTenant", async () => {
    op(); verified();
    H.users = [{ id: "u1", tenantId: "solo", identityId: "id_dana", role: "ADMIN" }];
    const r = await completeIt();
    expect(r.body.code).toBe("SOLE_MEMBER_WORKSPACE");
    expect(H.erased).toHaveLength(0);
    const ok = await completeIt({ eraseWorkspaces: ["solo"] });
    expect(ok.status).toBe(200);
    expect(H.erased).toEqual([{ kind: "tenant", tenantId: "solo" }]);
  });

  it("a named workspace the erasure refuses (e.g. an active paid plan): 409 WORKSPACE_NOT_ERASABLE, nothing erased", async () => {
    op(); verified();
    H.users = [{ id: "u1", tenantId: "solo", identityId: "id_dana", role: "ADMIN" }];
    H.refusal = { code: "ACTIVE_PAID_SUBSCRIPTION" };
    const r = await completeIt({ eraseWorkspaces: ["solo"] });
    expect(r.body.code).toBe("WORKSPACE_NOT_ERASABLE");
    expect(H.erased).toHaveLength(0);
  });

  it("a SYSTEM_ADMIN is never erased here", async () => {
    op(); verified();
    H.users = [{ id: "u1", tenantId: "t1", identityId: "id_dana", role: "SYSTEM_ADMIN" }];
    expect((await completeIt()).body.code).toBe("SYSTEM_ADMIN");
    expect(H.erased).toHaveLength(0);
  });

  it("the operator list never exposes the token or IP hashes", async () => {
    op(); verified({ tokenHash: "abc", ipHash: "def" });
    const r = await request(app()).get("/api/system/account-deletion-requests?status=VERIFIED");
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toMatch(/abc|def/);
    expect(r.body.data[0].memberships[0]).toMatchObject({ tenantId: "t1", lastOwner: false, soleMember: false });
  });

  it("reject: REJECTED with the reason, nothing erased", async () => {
    op(); verified();
    const r = await request(app()).post("/api/system/account-deletion-requests/adr1/reject").send({ reason: "not the holder" });
    expect(r.status).toBe(200);
    expect(H.rows[0]).toMatchObject({ status: "REJECTED", rejectedReason: "not the holder" });
    expect(H.erased).toHaveLength(0);
  });
});
