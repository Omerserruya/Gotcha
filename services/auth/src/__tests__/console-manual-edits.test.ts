/**
 * Console manual edits and the tenant delete, through the real routes
 * (Omer, 2026-10-23).
 *
 * Mocks only: billing is a stubbed fetch (dev's iCount is production's), and
 * Authentik is a stub that records what it was asked to do.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  tenants: [] as any[],
  users: [] as any[],
  identities: [] as any[],
  audits: [] as any[],
  checkouts: [] as any[],
  checkoutUnknown: false,
  subs: [] as any[],
  shopify: [] as any[],
  idp: { users: [] as any[], updates: [] as any[], failUpdate: false, applyThenThrow: false, readThrows: false },
  revoked: [] as string[],
  owners: true,
  planAccess: { state: "MISSING", label: "Missing", active: false, planKey: null, planName: null, expiresAt: null } as any,
  erase: [] as any[],
  caller: { userId: "sa1", role: "SYSTEM_ADMIN", tenantId: "SYS" } as any,
}));

/** Authentik's side of "Sign in with Google" for the email edit (2026-11-22). */
const G = vi.hoisted(() => ({
  connections: [] as { id: string; userPk: number; sourceSlug: string }[],
  /** What "has a usable password" answers: true, false, or null for "could not be told". */
  password: null as boolean | null,
  failList: false,
  failDelete: false,
  listed: 0,
  /** Each removal, with how many Authentik email writes had happened before it. */
  removed: [] as string[],
}));

// Checkouts are billing's table: auth asks billing, never reads it (2026-11-01).
vi.mock("../services/billing-checkout", () => ({
  hasOpenCheckout: async (tenantId: string) => (H.checkoutUnknown ? null : H.checkouts.some((c) => c.tenantId === tenantId)),
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const db: any = {
    tenant: {
      findUnique: async ({ where }: any) => H.tenants.find((t) => (where.id ? t.id === where.id : t.slug === where.slug)) ?? null,
      update: async ({ where, data }: any) => Object.assign(H.tenants.find((t) => t.id === where.id), data),
    },
    user: {
      findFirst: async ({ where }: any) =>
        H.users.find((u) => u.id === (where.id ?? u.id) && u.tenantId === where.tenantId &&
          (where.email ? u.email.toLowerCase() === String(where.email.equals ?? where.email).toLowerCase() : true) &&
          (where.id?.not ? u.id !== where.id.not : true)) ?? null,
      count: async ({ where }: any) => H.users.filter((u) => u.identityId === where.identityId && u.id !== where.id?.not).length,
      update: async ({ where, data }: any) => Object.assign(H.users.find((u) => u.id === where.id), data),
      delete: async ({ where }: any) => { H.users = H.users.filter((u) => u.id !== where.id); },
    },
    identity: {
      findFirst: async ({ where }: any) => H.identities.find((i) => i.email === where.email && i.id !== where.id?.not) ?? null,
      update: async ({ where, data }: any) => Object.assign(H.identities.find((i) => i.id === where.id), data),
    },
    billableEntityTenant: {
      findFirst: async ({ where }: any) => {
        const sub = H.subs.find((s) => s.tenantId === where.tenantId);
        return sub ? { entity: { subscription: sub } } : null;
      },
      findMany: async ({ where }: any) => H.subs.filter((s) => s.tenantId === where.tenantId).map((s) => ({ entity: { subscription: s } })),
    },
    providerSubscription: { findFirst: async ({ where }: any) => H.shopify.find((p) => p.tenantId === where.tenantId) ?? null },
    plan: { findFirst: async () => ({ kind: "PUBLIC", basePrice: "190.00" }) },
  };
  db.$transaction = async (fn: any) => fn(db);
  // Attach the identity relation the admin-email route selects.
  const withIdentity = (u: any) => (u ? { ...u, identity: H.identities.find((i) => i.id === u.identityId) ?? null } : u);
  const findFirst = db.user.findFirst;
  db.user.findFirst = async (a: any) => withIdentity(await findFirst(a));
  return {
    ...actual,
    prisma: db,
    authenticate: (req: any, _r: any, n: any) => { req.user = { ...H.caller }; n(); },
    requireSystemAdmin: () => (_q: any, _s: any, n: any) => n(),
    crossTenantMiddleware: (_q: any, _s: any, n: any) => n(),
    writeAudit: async (a: any) => { H.audits.push(a); },
    resolveTenantPlanAccess: async () => H.planAccess,
    getInternalServiceKey: () => "k",
    findIdentityBySubject: async (subject: string) => {
      if (H.idp.readThrows) throw new Error("[authentik] GET -> timeout");
      return H.idp.users.find((u) => u.subject === subject) ?? null;
    },
    findIdentityByEmail: async (email: string) => H.idp.users.find((u) => u.email.toLowerCase() === email.toLowerCase()) ?? null,
    updateIdentity: async (pk: number, attrs: any) => {
      if (H.idp.failUpdate) throw new Error("[authentik] PATCH -> 500");
      H.idp.updates.push({ pk, ...attrs });
      Object.assign(H.idp.users.find((u) => u.pk === pk), attrs);
      // Applied in Authentik, but the reply never arrived.
      if (H.idp.applyThenThrow) throw new Error("[authentik] PATCH -> timeout");
    },
    listUserSourceConnections: async (pk: number) => {
      G.listed++;
      if (G.failList) throw new Error("[authentik] GET -> 500");
      return G.connections.filter((c) => c.userPk === pk).map((c) => ({ id: c.id, sourceSlug: c.sourceSlug }));
    },
    hasUsablePassword: async () => G.password,
    deleteOAuthSourceConnection: async (id: string) => {
      if (G.failDelete) throw new Error("[authentik] DELETE -> 500");
      G.removed.push(`${id} after ${H.idp.updates.length} email writes`);
      G.connections = G.connections.filter((c) => c.id !== id);
    },
  };
});

vi.mock("../services/invitation.service", async () => {
  class InviteRefused extends Error { constructor(readonly code: string, m: string) { super(m); } }
  return {
  InviteRefused,
  inviteUser: async (tenantId: string, email: string, name: string, role: string) => {
    if (H.users.some((u) => u.tenantId === tenantId && u.email.toLowerCase() === email.toLowerCase())) {
      throw new InviteRefused("USER_EXISTS", "User with this email already exists for this tenant");
    }
    if (email === "clash@x.test") throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    const user = { id: `u_${email}`, tenantId, email, name, role, isActive: true };
    H.users.push(user);
    return { user, setupLink: "https://auth.example/setup" };
  },
  revokeUserAccess: async (id: string) => { H.revoked.push(id); },
  syncIdentityNameByUser: async () => {},
  syncMembershipAccess: async () => {},
  tenantAdminEntry: async () => null,
  };
});
vi.mock("../services/role-guard", () => ({ ownerRemainsWithout: async () => H.owners }));
vi.mock("../services/gdpr.service", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    eraseTenant: async (tenantId: string, actor: string, opts: any) => {
      H.erase.push({ tenantId, actor, opts });
      return { deleted: true, tenantId, providerLeftovers: [], uploadsRemoved: true };
    },
  };
});
vi.mock("../services/notification.service", () => ({ sendOnboardingEmail: async () => {}, sendPaidOnboardingEmail: async () => {} }));
vi.mock("../services/billing-provisioning.service", () => ({ createProvisioningRequest: async () => ({}), runProvisioning: async () => ({}), provisioningStatusForTenant: async () => ({}) }));
vi.mock("../services/nudge-engine.service", () => ({ scheduleOnboardingNudge: async () => {}, triggerNudgeNow: async () => {} }));
vi.mock("../services/onboarding-state.service", () => ({ listOnboardingSnapshots: async () => [], getOnboardingSnapshot: async () => null }));
vi.mock("../services/setup-link.service", () => ({ issueSetupLink: async () => null }));

import manualRouter from "../routes/system-manual-edits";
import systemRouter from "../routes/system";

const app = express();
app.use(express.json());
app.use("/api/system", manualRouter);
app.use("/api/system", systemRouter);

let fetchCalls: any[] = [];
let billingReply: { status: number; body: any } = { status: 200, body: {} };

beforeEach(() => {
  H.tenants = [
    { id: "T", slug: "acme", name: "Acme", status: "PENDING_PAYMENT" },
    { id: "SYS", slug: "system", name: "System", status: "ACTIVE" },
  ];
  H.identities = [{ id: "i1", email: "owner@acme.test", authentikSubject: "sub1" }];
  H.users = [
    { id: "u1", tenantId: "T", email: "owner@acme.test", name: "Owner", role: "ADMIN", isActive: true, identityId: "i1" },
    { id: "u2", tenantId: "T", email: "agent@acme.test", name: "Agent", role: "AGENT", isActive: true, identityId: "i2" },
  ];
  H.idp = { users: [{ subject: "sub1", pk: 7, email: "owner@acme.test", username: "owner@acme.test" }], updates: [], failUpdate: false, applyThenThrow: false, readThrows: false };
  H.audits = []; H.checkouts = []; H.checkoutUnknown = false; H.subs = []; H.shopify = []; H.revoked = []; H.erase = [];
  H.owners = true;
  H.planAccess = { state: "MISSING", label: "Missing", active: false, planKey: null, planName: null, expiresAt: null };
  H.caller = { userId: "sa1", role: "SYSTEM_ADMIN", tenantId: "SYS" };
  G.connections = []; G.password = null; G.failList = false; G.failDelete = false; G.listed = 0; G.removed = [];
  delete process.env.AUTHENTIK_GOOGLE_SOURCE_SLUG;
  fetchCalls = [];
  billingReply = { status: 200, body: {} };
  vi.stubGlobal("fetch", async (url: string, init: any) => {
    fetchCalls.push({ url, body: JSON.parse(init.body) });
    return { status: billingReply.status, ok: billingReply.status < 300, json: async () => billingReply.body } as any;
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("PATCH /tenants/:id/status", () => {
  it("sets the status with no gate, audits before/after/reason, and says when access is still denied", async () => {
    H.checkouts.push({ tenantId: "T" });
    const r = await request(app).patch("/api/system/tenants/T/status").send({ status: "ACTIVE", reason: "paid by transfer" });
    expect(r.status).toBe(200);
    expect(H.tenants[0].status).toBe("ACTIVE");
    expect(r.body.data).toMatchObject({ before: { status: "PENDING_PAYMENT" }, after: { status: "ACTIVE" }, planAccess: { state: "MISSING" } });
    expect(r.body.data.warnings).toEqual(expect.arrayContaining(["no_access_source", "open_checkout"]));
    expect(H.audits).toEqual([expect.objectContaining({
      action: "tenant.status_set_manually", actorId: "sa1",
      metadata: { before: { status: "PENDING_PAYMENT" }, after: { status: "ACTIVE" }, reason: "paid by transfer" },
    })]);
    expect(fetchCalls).toEqual([]);
  });

  it("billing unable to say whether a checkout is open: the status is set, with a warning that says so", async () => {
    H.checkoutUnknown = true;
    const r = await request(app).patch("/api/system/tenants/T/status").send({ status: "ACTIVE", reason: "paid by transfer" });
    expect(r.status).toBe(200);
    expect(r.body.data.warnings).toEqual(expect.arrayContaining(["open_checkout_unknown"]));
    expect(r.body.data.warnings).not.toContain("open_checkout");
  });

  it("warns that a renewal will undo a manual suspend", async () => {
    H.tenants[0].status = "ACTIVE";
    H.subs.push({ tenantId: "T", status: "ACTIVE", cancelAtPeriodEnd: false });
    const r = await request(app).patch("/api/system/tenants/T/status").send({ status: "SUSPENDED", reason: "r" });
    expect(r.body.data.warnings).toContain("renewal_will_unsuspend");
  });

  it("the same status is a no-op: no write, no audit", async () => {
    const r = await request(app).patch("/api/system/tenants/T/status").send({ status: "PENDING_PAYMENT", reason: "r" });
    expect(r.status).toBe(200);
    expect(H.audits).toEqual([]);
  });

  it("refuses a status that is not settable, and a missing reason", async () => {
    expect((await request(app).patch("/api/system/tenants/T/status").send({ status: "PENDING_ADMIN_SETUP", reason: "r" })).status).toBe(400);
    expect((await request(app).patch("/api/system/tenants/T/status").send({ status: "ACTIVE" })).status).toBe(400);
    expect((await request(app).patch("/api/system/tenants/T/status").send({ status: "ACTIVE", reason: "  " })).status).toBe(400);
    expect(H.tenants[0].status).toBe("PENDING_PAYMENT");
  });

  it("404 with a code for an unknown tenant", async () => {
    const r = await request(app).patch("/api/system/tenants/nope/status").send({ status: "ACTIVE", reason: "r" });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("TENANT_NOT_FOUND");
  });
});

describe("PATCH /tenants/:id/admin-email", () => {
  const send = (body: any) => request(app).patch("/api/system/tenants/T/admin-email").send({ userId: "u1", reason: "new owner", ...body });

  it("moves the login in Authentik first, then here; username follows when it was the email; audited", async () => {
    const r = await send({ newEmail: "New.Owner@Acme.test" });
    expect(r.status).toBe(200);
    expect(H.idp.updates).toEqual([{ pk: 7, email: "new.owner@acme.test", username: "new.owner@acme.test" }]);
    expect(H.users[0].email).toBe("new.owner@acme.test");
    expect(H.identities[0].email).toBe("new.owner@acme.test");
    expect(H.audits[0]).toMatchObject({
      action: "user.admin_email_changed",
      metadata: { before: { email: "owner@acme.test" }, after: { email: "new.owner@acme.test" }, reason: "new owner", idpUpdated: true },
    });
  });

  it("a username that is not the email is left alone", async () => {
    H.idp.users[0].username = "owner-handle";
    await send({ newEmail: "x@acme.test" });
    expect(H.idp.updates).toEqual([{ pk: 7, email: "x@acme.test" }]);
  });

  it("IDENTITY_SHARED: one login across tenants is not moved from one tenant's console", async () => {
    H.users.push({ id: "u9", tenantId: "OTHER", email: "owner@acme.test", identityId: "i1", role: "ADMIN" });
    const r = await send({ newEmail: "x@acme.test" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("IDENTITY_SHARED");
    expect(H.idp.updates).toEqual([]);
  });

  it("EMAIL_TAKEN in Authentik by another login", async () => {
    H.idp.users.push({ subject: "sub2", pk: 8, email: "taken@x.test", username: "taken@x.test" });
    const r = await send({ newEmail: "taken@x.test" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("EMAIL_TAKEN");
    expect(H.users[0].email).toBe("owner@acme.test");
  });

  it("IDP_SYNC_FAILED: Authentik refusing changes nothing locally", async () => {
    H.idp.failUpdate = true;
    const r = await send({ newEmail: "x@acme.test" });
    expect(r.status).toBe(502);
    expect(r.body.code).toBe("IDP_SYNC_FAILED");
    expect(H.users[0].email).toBe("owner@acme.test");
    expect(H.identities[0].email).toBe("owner@acme.test");
    expect(H.audits).toEqual([]);
  });

  it("a throw AFTER Authentik applied it is followed, not reported as a failure: no drift (review 5)", async () => {
    H.idp.applyThenThrow = true;
    const r = await send({ newEmail: "x@acme.test" });
    expect(r.status).toBe(200);
    expect(H.idp.users[0].email).toBe("x@acme.test");
    expect(H.users[0].email).toBe("x@acme.test");
    expect(H.identities[0].email).toBe("x@acme.test");
  });

  it("Authentik unreadable: IDP_STATE_UNKNOWN, nothing written here (review 5)", async () => {
    H.idp.readThrows = true;
    const r = await send({ newEmail: "x@acme.test" });
    expect(r.status).toBe(502);
    expect(r.body.code).toBe("IDP_STATE_UNKNOWN");
    expect(H.users[0].email).toBe("owner@acme.test");
    expect(H.audits).toEqual([]);
  });

  it("a retry after an unknown outcome is not a clash with itself", async () => {
    H.idp.users[0].email = "x@acme.test"; // the earlier attempt landed in Authentik only
    const r = await send({ newEmail: "x@acme.test" });
    expect(r.status).toBe(200);
    expect(H.users[0].email).toBe("x@acme.test");
  });

  it("SAME_EMAIL, SYSTEM_ADMIN and USER_NOT_FOUND", async () => {
    expect((await send({ newEmail: "OWNER@acme.test" })).body.code).toBe("SAME_EMAIL");
    H.users[0].role = "SYSTEM_ADMIN";
    expect((await send({ newEmail: "x@acme.test" })).body.code).toBe("SYSTEM_ADMIN");
    expect((await send({ userId: "ghost", newEmail: "x@acme.test" })).body.code).toBe("USER_NOT_FOUND");
  });
});

/**
 * The Google connection was made by matching the OLD address (2026-11-22). So
 * an email edit removes it, before the email moves, and is refused while no
 * usable password can be proven: removing it would lock the person out.
 */
describe("PATCH /tenants/:id/admin-email and the person's Google connection", () => {
  const send = (body: any = {}) => request(app).patch("/api/system/tenants/T/admin-email").send({ userId: "u1", reason: "new owner", newEmail: "x@acme.test", ...body });
  const google = (id = "31", userPk = 7) => ({ id, userPk, sourceSlug: "google" });
  const unchanged = () => {
    expect(H.users[0].email).toBe("owner@acme.test");
    expect(H.identities[0].email).toBe("owner@acme.test");
    expect(H.idp.users[0].email).toBe("owner@acme.test");
    expect(H.idp.updates).toEqual([]);
  };
  beforeEach(() => { process.env.AUTHENTIK_GOOGLE_SOURCE_SLUG = "google"; });

  it("connected and a password: the connection goes BEFORE the email moves, and the answer says so", async () => {
    G.connections = [google()];
    G.password = true;
    const r = await send();
    expect(r.status).toBe(200);
    expect(r.body.data.warnings).toEqual(["google_connection_removed"]);
    expect(G.removed).toEqual(["31 after 0 email writes"]);
    expect(H.idp.updates).toEqual([{ pk: 7, email: "x@acme.test", username: "x@acme.test" }]);
    expect(H.users[0].email).toBe("x@acme.test");
  });

  it("two audit lines: the removal (by the operator, not the person) and the edit", async () => {
    G.connections = [google()];
    G.password = true;
    await send();
    expect(H.audits).toEqual([
      {
        tenantId: "T", actorType: "user", actorId: "sa1", action: "auth.sign_in_connection_removed",
        targetType: "user", targetId: "u1", metadata: { self: false, provider: "google", reason: "email_change" },
      },
      {
        tenantId: "T", actorType: "user", actorId: "sa1", action: "user.admin_email_changed", targetType: "user", targetId: "u1",
        metadata: { before: { email: "owner@acme.test" }, after: { email: "x@acme.test" }, reason: "new owner", idpUpdated: true, googleDisconnected: true },
      },
    ]);
  });

  it.each([
    ["no password", false],
    ["a password that could not be told", null],
  ])("connected and %s: NO_OTHER_SIGN_IN, nothing changed anywhere", async (_name, password) => {
    G.connections = [google()];
    G.password = password;
    const r = await send();
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("NO_OTHER_SIGN_IN");
    unchanged();
    expect(G.removed).toEqual([]);
    expect(G.connections).toHaveLength(1);
    expect(H.audits).toEqual([]);
  });

  it("a connection to another source is not a password: still refused", async () => {
    G.connections = [google(), { id: "32", userPk: 7, sourceSlug: "microsoft" }];
    G.password = false;
    expect((await send()).body.code).toBe("NO_OTHER_SIGN_IN");
    expect(G.connections).toHaveLength(2);
  });

  it.each([
    ["no connection at all (an invited person whose address was mistyped)", []],
    ["only a connection to another source", [{ id: "32", userPk: 7, sourceSlug: "microsoft" }]],
    ["somebody else's Google connection", [{ id: "33", userPk: 8, sourceSlug: "google" }]],
  ])("%s, no password: not touched, the edit goes through", async (_name, connections) => {
    G.connections = connections;
    G.password = false;
    const r = await send();
    expect(r.status).toBe(200);
    expect(r.body.data.warnings).toEqual([]);
    expect(G.removed).toEqual([]);
    expect(G.connections).toHaveLength(connections.length);
    expect(H.audits.map((a) => a.action)).toEqual(["user.admin_email_changed"]);
    expect(H.audits[0].metadata).not.toHaveProperty("googleDisconnected");
  });

  it("only this person's Google connection goes", async () => {
    G.connections = [{ id: "32", userPk: 7, sourceSlug: "microsoft" }, google(), { id: "33", userPk: 8, sourceSlug: "google" }];
    G.password = true;
    await send();
    expect(G.connections.map((c) => c.id)).toEqual(["32", "33"]);
  });

  it("the connections cannot be read: IDP_STATE_UNKNOWN, nothing changed (not read as 'no connection')", async () => {
    G.connections = [google()];
    G.password = true;
    G.failList = true;
    const r = await send();
    expect(r.status).toBe(502);
    expect(r.body.code).toBe("IDP_STATE_UNKNOWN");
    expect(r.body).not.toHaveProperty("warnings");
    unchanged();
    expect(H.audits).toEqual([]);
  });

  it("the connection cannot be removed: IDP_STATE_UNKNOWN, the email does not move", async () => {
    G.connections = [google()];
    G.password = true;
    G.failDelete = true;
    const r = await send();
    expect(r.status).toBe(502);
    expect(r.body.code).toBe("IDP_STATE_UNKNOWN");
    expect(r.body).not.toHaveProperty("warnings");
    unchanged();
    expect(G.connections).toHaveLength(1);
    expect(H.audits).toEqual([]);
  });

  it("Authentik refuses the email after the connection went: nothing moved, and the answer says the connection is gone", async () => {
    G.connections = [google()];
    G.password = true;
    H.idp.failUpdate = true;
    const r = await send();
    expect(r.status).toBe(502);
    expect(r.body.code).toBe("IDP_SYNC_FAILED");
    expect(r.body.warnings).toEqual(["google_connection_removed"]);
    expect(r.body.error).toMatch(/Google connection was removed/);
    expect(H.users[0].email).toBe("owner@acme.test");
    expect(H.identities[0].email).toBe("owner@acme.test");
    expect(H.audits.map((a) => a.action)).toEqual(["auth.sign_in_connection_removed"]);
  });

  it("Authentik goes dark after the connection went: IDP_STATE_UNKNOWN still says the connection is gone", async () => {
    G.connections = [google()];
    G.password = true;
    // The email write throws, and from then on Authentik cannot be read back.
    Object.defineProperty(H.idp, "failUpdate", { get() { H.idp.readThrows = true; return true; } });
    const r = await send();
    expect(r.status).toBe(502);
    expect(r.body.code).toBe("IDP_STATE_UNKNOWN");
    expect(r.body.warnings).toEqual(["google_connection_removed"]);
    expect(H.users[0].email).toBe("owner@acme.test");
  });

  it("Authentik refuses the email and there was no connection: the answer is as it always was", async () => {
    H.idp.failUpdate = true;
    const r = await send();
    expect(r.body).toEqual({ error: "Authentik did not accept the change; nothing was changed", code: "IDP_SYNC_FAILED" });
  });

  it("an address another login holds is refused before the connection is looked at", async () => {
    H.idp.users.push({ subject: "sub2", pk: 8, email: "taken@x.test", username: "taken@x.test" });
    G.connections = [google()];
    G.password = true;
    const r = await send({ newEmail: "taken@x.test" });
    expect(r.body.code).toBe("EMAIL_TAKEN");
    expect(G.listed).toBe(0);
    expect(G.connections).toHaveLength(1);
  });

  it("a member with no Authentik identity: Authentik is not asked", async () => {
    H.identities[0].authentikSubject = null;
    G.connections = [google()];
    const r = await send();
    expect(r.status).toBe(200);
    expect(r.body.data.warnings).toEqual(["no_idp_identity"]);
    expect(G.listed).toBe(0);
  });

  it.each([[undefined], [""], ["   "]])("feature off (slug %j): the connection is not read and not removed, a Google-only person is not refused", async (slug) => {
    if (slug === undefined) delete process.env.AUTHENTIK_GOOGLE_SOURCE_SLUG; else process.env.AUTHENTIK_GOOGLE_SOURCE_SLUG = slug;
    G.connections = [google()];
    G.password = false;
    const r = await send();
    expect(r.status).toBe(200);
    expect(r.body.data.warnings).toEqual([]);
    expect(G.listed).toBe(0);
    expect(G.connections).toHaveLength(1);
  });
});

describe("POST /tenants/:id/billing/manual", () => {
  it("forwards to billing with the actor, audits before/after/reason, and returns renewal off", async () => {
    billingReply = { status: 200, body: { ok: true, before: { planKey: "starter" }, after: { planKey: "growth", cancelAtPeriodEnd: true }, renewal: "off", charges: "none", pendingChangeCleared: null, warnings: [] } };
    const r = await request(app).post("/api/system/tenants/T/billing/manual").send({ action: "change_plan", planVersionId: "pv", endsAt: "2026-12-31T00:00:00.000Z", reason: "deal" });
    expect(r.status).toBe(200);
    expect(fetchCalls[0].url).toMatch(/\/api\/internal\/billing\/manual-edit$/);
    expect(fetchCalls[0].body).toMatchObject({ action: "change_plan", tenantId: "T", actor: "sa1", reason: "deal" });
    expect(r.body.data).toMatchObject({ renewal: "off", charges: "none", after: { cancelAtPeriodEnd: true }, planAccess: { state: "MISSING" } });
    expect(H.audits[0]).toMatchObject({ action: "billing.manual_edit", metadata: { action: "change_plan", before: { planKey: "starter" }, after: { planKey: "growth" }, reason: "deal" } });
  });

  it("a billing refusal is a 409 with an upper-case code, and nothing is audited", async () => {
    billingReply = { status: 409, body: { error: "end_date_in_past" } };
    const r = await request(app).post("/api/system/tenants/T/billing/manual").send({ action: "set_end_date", endsAt: "2020-01-01T00:00:00.000Z", reason: "r" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("END_DATE_IN_PAST");
    expect(H.audits).toEqual([]);
  });

  it("rejects a price or an unknown field before billing is asked", async () => {
    const r = await request(app).post("/api/system/tenants/T/billing/manual").send({ action: "add_credits", units: 5, price: 0, reason: "r" });
    expect(r.status).toBe(400);
    expect(fetchCalls).toEqual([]);
  });
});

describe("users: add and remove", () => {
  it("POST keeps working without a reason, and audits before/after", async () => {
    const r = await request(app).post("/api/system/tenants/T/users").send({ email: "new@acme.test", name: "New", role: "AGENT" });
    expect(r.status).toBe(201);
    expect(H.audits[0]).toMatchObject({ action: "user.created", metadata: { before: null, after: { email: "new@acme.test" }, reason: null } });
  });

  it("POST for an existing member: 409 USER_EXISTS, case-insensitive, never a 500", async () => {
    const r = await request(app).post("/api/system/tenants/T/users").send({ email: "AGENT@acme.test", name: "Again", role: "AGENT" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("USER_EXISTS");
    expect(H.audits).toEqual([]);
  });

  it("POST whose email is held by another login: 409 EMAIL_TAKEN", async () => {
    const r = await request(app).post("/api/system/tenants/T/users").send({ email: "clash@x.test", name: "C", role: "AGENT" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("EMAIL_TAKEN");
  });

  it("DELETE revokes the login before the row goes, and audits before/after/reason", async () => {
    const r = await request(app).delete("/api/system/tenants/T/users/u2").send({ reason: "left the company" });
    expect(r.status).toBe(200);
    expect(H.revoked).toEqual(["u2"]);
    expect(H.users.find((u) => u.id === "u2")).toBeUndefined();
    expect(H.audits[0]).toMatchObject({ action: "user.deleted", metadata: { before: { email: "agent@acme.test" }, after: null, reason: "left the company" } });
  });

  it("DELETE refuses the last Owner: 409 LAST_ADMIN, nothing revoked", async () => {
    H.owners = false;
    const r = await request(app).delete("/api/system/tenants/T/users/u1").send({});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("LAST_ADMIN");
    expect(H.revoked).toEqual([]);
    expect(H.users).toHaveLength(2);
  });
});

describe("DELETE /tenants/:id", () => {
  const del = (id: string, body: any) => request(app).delete(`/api/system/tenants/${id}`).send(body);

  it("deletes with the slug retyped and a reason, passing the reason to the erasure", async () => {
    const r = await del("T", { confirmSlug: "acme", reason: "test org" });
    expect(r.status).toBe(200);
    expect(H.erase).toEqual([{ tenantId: "T", actor: "sa1", opts: { reason: "test org" } }]);
    expect(r.body.data).toMatchObject({ deleted: true, tenantName: "Acme" });
  });

  const refusals: Array<[string, () => void, any, number, string]> = [
    ["slug mismatch", () => {}, { confirmSlug: "acm", reason: "r" }, 400, "CONFIRM_SLUG_MISMATCH"],
    ["the System tenant", () => {}, { confirmSlug: "system", reason: "r" }, 409, "SYSTEM_TENANT"],
    ["the caller's own tenant", () => { H.caller.tenantId = "T"; }, { confirmSlug: "acme", reason: "r" }, 409, "OWN_TENANT"],
    ["a renewing paid plan", () => { H.subs.push({ tenantId: "T", status: "ACTIVE", cancelAtPeriodEnd: false, planKey: "starter", planVersion: 1, snapshotPrice: "190.00" }); }, { confirmSlug: "acme", reason: "r" }, 409, "ACTIVE_PAID_SUBSCRIPTION"],
    ["dunning", () => { H.subs.push({ tenantId: "T", status: "PAST_DUE", cancelAtPeriodEnd: false, planKey: "starter", planVersion: 1 }); }, { confirmSlug: "acme", reason: "r" }, 409, "ACTIVE_PAID_SUBSCRIPTION"],
    ["an open checkout", () => { H.checkouts.push({ tenantId: "T" }); }, { confirmSlug: "acme", reason: "r" }, 409, "OPEN_CHECKOUT"],
    ["billing unable to say whether a checkout is open", () => { H.checkoutUnknown = true; }, { confirmSlug: "acme", reason: "r" }, 409, "OPEN_CHECKOUT"],
    ["Shopify-billed", () => { H.shopify.push({ tenantId: "T" }); }, { confirmSlug: "acme", reason: "r" }, 409, "SHOPIFY_BILLED"],
  ];
  for (const [name, setup, body, status, code] of refusals) {
    it(`refuses ${name}: ${status} ${code}, nothing erased`, async () => {
      setup();
      const id = name === "the System tenant" ? "SYS" : "T";
      const r = await del(id, body);
      expect(r.status).toBe(status);
      expect(r.body.code).toBe(code);
      expect(H.erase).toEqual([]);
    });
  }

  it("a paid plan with renewal off (a manual edit) can be deleted: it can never charge", async () => {
    H.subs.push({ tenantId: "T", status: "ACTIVE", cancelAtPeriodEnd: true, planKey: "starter", planVersion: 1, snapshotPrice: "190.00" });
    expect((await del("T", { confirmSlug: "acme", reason: "r" })).status).toBe(200);
  });

  it("no reason, or no slug: 400 before anything is read", async () => {
    expect((await del("T", { confirmSlug: "acme" })).status).toBe(400);
    expect((await del("T", { reason: "r" })).status).toBe(400);
    expect(H.erase).toEqual([]);
  });

  it("404 TENANT_NOT_FOUND", async () => {
    const r = await del("nope", { confirmSlug: "nope", reason: "r" });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("TENANT_NOT_FOUND");
  });
});
