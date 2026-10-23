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
  subs: [] as any[],
  shopify: [] as any[],
  idp: { users: [] as any[], updates: [] as any[], failUpdate: false, applyThenThrow: false, readThrows: false },
  revoked: [] as string[],
  owners: true,
  planAccess: { state: "MISSING", label: "Missing", active: false, planKey: null, planName: null, expiresAt: null } as any,
  erase: [] as any[],
  caller: { userId: "sa1", role: "SYSTEM_ADMIN", tenantId: "SYS" } as any,
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
    pendingCheckout: { findFirst: async ({ where }: any) => H.checkouts.find((c) => c.tenantId === where.tenantId) ?? null },
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
  H.audits = []; H.checkouts = []; H.subs = []; H.shopify = []; H.revoked = []; H.erase = [];
  H.owners = true;
  H.planAccess = { state: "MISSING", label: "Missing", active: false, planKey: null, planName: null, expiresAt: null };
  H.caller = { userId: "sa1", role: "SYSTEM_ADMIN", tenantId: "SYS" };
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
