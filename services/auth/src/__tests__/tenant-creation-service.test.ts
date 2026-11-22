/**
 * Creating an organization and its first admin, as one function (2026-11-22).
 *
 * The console's "new organization" and the public sign-up both end in
 * createTenantWithAdmin, so what is pinned here is the order and the refusals
 * that both doors rely on:
 *  - a selection that is wrong is refused while nothing exists yet;
 *  - a taken slug creates no Authentik user;
 *  - the provisioning request is written before billing is called;
 *  - a failed plan setup answers 502 with the ids, and sends NO email;
 *  - the audit lines name who asked, a person or a system door.
 *
 * Mocks only. Billing is never called: runProvisioning is a stub, and dev's
 * billing talks to the real payment provider.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({
  steps: [] as string[],
  tenants: [] as any[],
  users: [] as any[],
  audits: [] as any[],
  events: [] as any[],
  provRequests: [] as any[],
  emails: [] as any[],
  paidEmails: [] as any[],
  nudges: [] as any[],
  provisioning: { ok: true, state: "SUCCEEDED", body: {} as any, failureCode: undefined as string | undefined },
  billingCalls: [] as any[],
  validatePaid: { ok: true, body: {} as any },
  identityFails: false,
}));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  const db: any = {
    tenant: {
      findUnique: async ({ where }: any) => H.tenants.find((t) => t.slug === where.slug) ?? null,
      create: async ({ data }: any) => {
        H.steps.push("tenant.create");
        const row = { id: `t_${data.slug}`, ...data };
        H.tenants.push(row);
        return row;
      },
    },
    user: {
      create: async ({ data }: any) => {
        H.steps.push("user.create");
        const row = { id: `u_${data.email}`, ...data };
        H.users.push(row);
        return row;
      },
    },
    tenantOnboarding: { create: async ({ data }: any) => { H.steps.push(`onboarding.create:${data.currentStep}`); return data; } },
    identity: {
      upsert: async ({ where, create }: any) => { H.steps.push("identity.upsert"); return { id: `i_${where.authentikSubject}`, ...create }; },
    },
  };
  db.$transaction = async (fn: any) => fn(db);
  return {
    ...actual,
    prisma: db,
    authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "sa1", role: "SYSTEM_ADMIN", tenantId: "SYS" }; n(); },
    requireSystemAdmin: () => (_q: any, _s: any, n: any) => n(),
    requirePlatformPermission: () => (_q: any, _s: any, n: any) => n(),
    crossTenantMiddleware: (_q: any, _s: any, n: any) => n(),
    ensureIdentity: async (email: string, name: string) => {
      H.steps.push("ensureIdentity");
      if (H.identityFails) throw new Error("[authentik] POST -> 500");
      return { subject: `sub-${email}`, pk: 7, email, name };
    },
    seedTenantRbac: async (tenantId: string) => { H.steps.push(`seedTenantRbac:${tenantId}`); },
    writeAudit: async (a: any) => { H.audits.push(a); },
    publishEvent: async (e: any) => { H.steps.push(`event:${e.event}`); H.events.push(e); },
  };
});
vi.mock("../lib/billing-internal", () => ({
  callBilling: async (path: string, body: any) => { H.steps.push(`billing:${path}`); H.billingCalls.push({ path, body }); return H.validatePaid; },
  callBillingGet: async () => ({ ok: true, body: {} }),
}));
vi.mock("../services/notification.service", () => ({
  sendOnboardingEmail: async (...args: any[]) => { H.steps.push("sendOnboardingEmail"); H.emails.push(args); },
  sendPaidOnboardingEmail: async (a: any) => { H.steps.push("sendPaidOnboardingEmail"); H.paidEmails.push(a); },
}));
vi.mock("../services/billing-provisioning.service", () => ({
  createProvisioningRequest: async (a: any) => { H.steps.push("createProvisioningRequest"); H.provRequests.push(a); return { id: "pr1" }; },
  runProvisioning: async (id: string) => { H.steps.push(`runProvisioning:${id}`); return H.provisioning; },
  provisioningStatusForTenant: async () => ({}),
}));
vi.mock("../services/nudge-engine.service", () => ({
  scheduleOnboardingNudge: async (tenantId: string, delay: string) => { H.nudges.push([tenantId, delay]); },
  triggerNudgeNow: async () => {},
}));
vi.mock("../services/invitation.service", () => {
  class InviteRefused extends Error {}
  return {
    InviteRefused,
    inviteUser: async () => ({}),
    revokeUserAccess: async () => {},
    syncIdentityNameByUser: async () => {},
    syncMembershipAccess: async () => {},
    tenantAdminEntry: async () => ({ needsPassword: true, actionUrl: "https://app.example/setup/abc" }),
  };
});
vi.mock("../services/onboarding-state.service", () => ({ listOnboardingSnapshots: async () => [], getOnboardingSnapshot: async () => null }));
vi.mock("../services/setup-link.service", () => ({ issueSetupLink: async () => null }));
vi.mock("../services/role-guard", () => ({ ownerRemainsWithout: async () => true }));

import { createTenantWithAdmin, LICENSE_DOMAINS, type TenantCreationInput } from "../services/tenant-creation.service";
import systemRouter from "../routes/system";

const AREA = LICENSE_DOMAINS[0] as string;
const FUTURE = new Date(Date.now() + 14 * 86_400_000).toISOString();

const poc = (over: Partial<TenantCreationInput> = {}, billing: Record<string, unknown> = {}): TenantCreationInput => ({
  name: "Acme Flowers",
  slug: "acme-flowers",
  adminEmail: "dana@acme-flowers.test",
  adminName: "Dana",
  locale: "en",
  billing: { mode: "POC", pocCredits: 5000, pocExpiresAt: FUTURE, pocFeatureAreas: [AREA], ...billing } as any,
  actor: { type: "user", id: "sa1" },
  ...over,
});
const paid = (over: Partial<TenantCreationInput> = {}): TenantCreationInput => ({
  ...poc(),
  billing: { mode: "PAID_PLAN", planVersionId: "pv_1", billingInterval: "MONTHLY" },
  ...over,
});

const PAID_BODY = {
  checkoutReference: "chk_1",
  link: { id: "l1", token: "raw-token", expiresAt: FUTURE },
  summary: { planKey: "pro", planVersion: 3, planName: "Pro", amount: "190.00", currency: "ILS", includedCredits: 1000, billingInterval: "MONTHLY" },
};

beforeEach(() => {
  H.steps = []; H.tenants = []; H.users = []; H.audits = []; H.events = []; H.provRequests = [];
  H.emails = []; H.paidEmails = []; H.nudges = []; H.billingCalls = [];
  H.provisioning = { ok: true, state: "SUCCEEDED", body: { credits: 5000, expiresAt: FUTURE, featuresEnabled: [AREA], featuresDenied: [] }, failureCode: undefined };
  H.validatePaid = { ok: true, body: {} };
  H.identityFails = false;
});

describe("an evaluation organization", () => {
  it("is created in order: identity, rows, roles, event, durable request, billing, email", async () => {
    const out = await createTenantWithAdmin(poc());
    expect(H.steps).toEqual([
      "ensureIdentity",
      "identity.upsert",
      "tenant.create",
      "user.create",
      "onboarding.create:BUSINESS_PROFILE",
      "seedTenantRbac:t_acme-flowers",
      "event:tenant:created",
      "createProvisioningRequest",
      "runProvisioning:pr1",
      "sendOnboardingEmail",
    ]);
    expect(out.status).toBe(201);
    expect(out.created).toEqual({ tenantId: "t_acme-flowers", adminUserId: "u_dana@acme-flowers.test" });
  });

  it("waits for its admin, in the workspace's language, with the admin as ADMIN", async () => {
    await createTenantWithAdmin(poc());
    expect(H.tenants).toEqual([{ id: "t_acme-flowers", name: "Acme Flowers", slug: "acme-flowers", status: "PENDING_ADMIN_SETUP", defaultLocale: "en" }]);
    expect(H.users).toEqual([{
      id: "u_dana@acme-flowers.test", tenantId: "t_acme-flowers", identityId: "i_sub-dana@acme-flowers.test",
      email: "dana@acme-flowers.test", name: "Dana", role: "ADMIN",
    }]);
  });

  it("asks billing for exactly the evaluation it was given", async () => {
    await createTenantWithAdmin(poc({}, { commercialNote: "pilot" }));
    expect(H.provRequests).toEqual([{
      tenantId: "t_acme-flowers",
      requestedBy: "sa1",
      selection: { mode: "POC", planVersionId: null, commercialNote: "pilot", pocCredits: 5000, pocExpiresAt: new Date(FUTURE), pocFeatureAreas: [AREA] },
    }]);
    // No paid-plan validation call for an evaluation.
    expect(H.billingCalls).toEqual([]);
  });

  it("sends the setup email with the workspace's language, and arms the one-day nudge", async () => {
    await createTenantWithAdmin(poc());
    expect(H.emails).toEqual([["t_acme-flowers", "dana@acme-flowers.test", "Dana", "Acme Flowers", "acme-flowers", "u_dana@acme-flowers.test", "en"]]);
    expect(H.paidEmails).toEqual([]);
    expect(H.nudges).toEqual([["t_acme-flowers", "1d"]]);
  });

  it("answers the console's summary of the evaluation", async () => {
    const out = await createTenantWithAdmin(poc());
    expect(out.body).toEqual({
      data: {
        tenant: { id: "t_acme-flowers", name: "Acme Flowers", slug: "acme-flowers", status: "PENDING_ADMIN_SETUP" },
        admin: { id: "u_dana@acme-flowers.test", email: "dana@acme-flowers.test", name: "Dana" },
        billing: {
          mode: "POC", credits: 5000, expiresAt: FUTURE, featuresEnabled: [AREA], featuresDenied: [],
          charges: "none", renewal: "none", paidAccessGranted: true,
        },
      },
    });
  });
});

describe("refused while nothing exists yet", () => {
  const nothingCreated = () => {
    expect(H.steps).toEqual([]);
    expect(H.tenants).toEqual([]);
    expect(H.emails).toEqual([]);
  };

  it.each([
    ["an expiry in the past", { pocExpiresAt: "2020-01-01T00:00:00.000Z" }],
    ["an expiry of this very moment", { pocExpiresAt: new Date(Date.now() - 1).toISOString() }],
    ["an expiry that is not a date", { pocExpiresAt: "soon" }],
  ])("%s", async (_name, billing) => {
    const out = await createTenantWithAdmin(poc({}, billing));
    expect(out).toEqual({ status: 400, body: { error: "Invalid billing selection", code: "expiry_must_be_in_the_future" } });
    nothingCreated();
  });

  it("a feature area the product does not have", async () => {
    const out = await createTenantWithAdmin(poc({}, { pocFeatureAreas: [AREA, "teleportation"] }));
    expect(out).toEqual({ status: 400, body: { error: "Invalid billing selection", code: "unknown_feature_domain", domains: ["teleportation"] } });
    nothingCreated();
  });

  it("a slug that is taken: 409, and no Authentik user is made for it", async () => {
    H.tenants.push({ id: "t_old", slug: "acme-flowers" });
    const out = await createTenantWithAdmin(poc());
    expect(out).toEqual({ status: 409, body: { error: "A tenant with this slug already exists" } });
    expect(H.steps).toEqual([]);
    expect(H.tenants).toHaveLength(1);
  });

  it("a paid plan billing does not accept: 400 with billing's code, before any row", async () => {
    H.validatePaid = { ok: false, body: { error: "plan_version_not_active" } };
    const out = await createTenantWithAdmin(paid());
    expect(out).toEqual({ status: 400, body: { error: "Invalid billing selection", code: "plan_version_not_active" } });
    expect(H.steps).toEqual(["billing:validate-paid-plan"]);
    expect(H.tenants).toEqual([]);
  });

  it("Authentik down: it throws for the caller to answer, with no tenant row", async () => {
    H.identityFails = true;
    await expect(createTenantWithAdmin(poc())).rejects.toThrow(/authentik/);
    expect(H.tenants).toEqual([]);
    expect(H.users).toEqual([]);
  });
});

describe("the plan setup did not complete", () => {
  beforeEach(() => {
    H.provisioning = { ok: false, state: "FAILED_RETRYABLE", body: { error: "billing_unreachable" }, failureCode: "billing_unreachable" };
  });

  it("502 with the ids and a repairable state, and no email to anyone", async () => {
    const out = await createTenantWithAdmin(poc());
    expect(out.status).toBe(502);
    expect(out.created).toEqual({ tenantId: "t_acme-flowers", adminUserId: "u_dana@acme-flowers.test" });
    expect(out.body).toEqual({
      error: "Tenant created but plan setup did not complete",
      code: "billing_unreachable",
      data: {
        tenant: { id: "t_acme-flowers", name: "Acme Flowers", slug: "acme-flowers", status: "PENDING_ADMIN_SETUP" },
        admin: { id: "u_dana@acme-flowers.test", email: "dana@acme-flowers.test", name: "Dana" },
        billing: { mode: "POC", provisioningState: "FAILED_RETRYABLE", canRepair: true, paidAccessGranted: false, emailSent: false },
      },
    });
    expect(H.emails).toEqual([]);
    expect(H.paidEmails).toEqual([]);
    expect(H.nudges).toEqual([]);
  });

  it("a failure retrying cannot fix is not offered a repair", async () => {
    H.provisioning = { ok: false, state: "FAILED_PERMANENT", body: { error: "unknown_feature_domain" }, failureCode: "unknown_feature_domain" };
    const out = await createTenantWithAdmin(poc());
    expect(out.body.data.billing.canRepair).toBe(false);
    expect(out.body.code).toBe("unknown_feature_domain");
  });
});

describe("who asked", () => {
  const actors = () => H.audits.map((a) => [a.action, a.actorType, a.actorId]);

  it("an operator: every line carries the person", async () => {
    await createTenantWithAdmin(poc());
    expect(actors()).toEqual([
      ["tenant.created", "user", "sa1"],
      ["user.created", "user", "sa1"],
      [expect.stringMatching(/poc/i), "user", "sa1"],
    ]);
    expect(H.provRequests[0].requestedBy).toBe("sa1");
  });

  it("a system door with no person: 'system', no actor id, and no requester on the request", async () => {
    await createTenantWithAdmin(poc({ actor: { type: "system", id: null } }));
    expect(H.audits.length).toBe(3);
    for (const a of H.audits) {
      expect(a.actorType).toBe("system");
      expect(a.actorId).toBeUndefined();
    }
    expect(H.provRequests[0].requestedBy).toBeNull();
  });

  it("a failed setup is audited under the same actor", async () => {
    H.provisioning = { ok: false, state: "FAILED_RETRYABLE", body: { error: "billing_unreachable" }, failureCode: "billing_unreachable" };
    await createTenantWithAdmin(poc({ actor: { type: "system", id: null } }));
    const failed = H.audits[H.audits.length - 1];
    expect(failed.actorType).toBe("system");
    expect(failed.metadata).toEqual({ mode: "POC", failureCode: "billing_unreachable" });
  });
});

describe("a paid organization", () => {
  beforeEach(() => {
    H.provisioning = { ok: true, state: "SUCCEEDED", body: PAID_BODY, failureCode: undefined };
  });

  it("starts owing money, and gets the paid email with the setup link, never the evaluation one", async () => {
    const out = await createTenantWithAdmin(paid());
    expect(out.status).toBe(201);
    expect(H.tenants[0].status).toBe("PENDING_PAYMENT");
    expect(H.emails).toEqual([]);
    expect(H.paidEmails).toHaveLength(1);
    expect(H.paidEmails[0]).toMatchObject({
      tenantId: "t_acme-flowers", adminEmail: "dana@acme-flowers.test", continuationToken: "raw-token",
      checkoutReference: "chk_1", planName: "Pro", amount: "190.00", currency: "ILS",
      setupUrl: "https://app.example/setup/abc", locale: "en",
    });
    expect(out.body.data.billing).toEqual({
      mode: "PAID_PLAN", checkoutReference: "chk_1", planName: "Pro", amount: "190.00", currency: "ILS",
      includedCredits: 1000, billingInterval: "MONTHLY", linkExpiresAt: FUTURE, paidAccessGranted: false,
    });
  });

  it("the raw payment token is in the one email and nowhere in the answer or the audit", async () => {
    const out = await createTenantWithAdmin(paid());
    expect(JSON.stringify(out.body)).not.toContain("raw-token");
    expect(JSON.stringify(H.audits)).not.toContain("raw-token");
  });

  it("validates the selection first, with the option keys only", async () => {
    await createTenantWithAdmin(paid());
    expect(H.steps[0]).toBe("billing:validate-paid-plan");
    expect(H.billingCalls[0].body).toEqual({ planVersionId: "pv_1", chatVolumeOptionKey: null, voiceVolumeOptionKey: null, billingInterval: "MONTHLY" });
  });
});

describe("POST /api/system/tenants", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/system", systemRouter);
  const body = () => ({
    name: "Acme Flowers", slug: "acme-flowers", adminEmail: "dana@acme-flowers.test", adminName: "Dana", locale: "en",
    billing: { mode: "POC", pocCredits: 5000, pocExpiresAt: FUTURE, pocFeatureAreas: [AREA] },
  });

  it("answers the function's status and body, with the signed-in operator as the actor", async () => {
    const r = await request(app).post("/api/system/tenants").send(body());
    expect(r.status).toBe(201);
    expect(r.body.data.tenant).toEqual({ id: "t_acme-flowers", name: "Acme Flowers", slug: "acme-flowers", status: "PENDING_ADMIN_SETUP" });
    expect(r.body.data.billing.mode).toBe("POC");
    // The ids for a caller's own rows are not part of the HTTP answer.
    expect(r.body.created).toBeUndefined();
    expect(H.audits[0]).toMatchObject({ actorType: "user", actorId: "sa1" });
  });

  it("a taken slug is the function's 409", async () => {
    H.tenants.push({ id: "t_old", slug: "acme-flowers" });
    const r = await request(app).post("/api/system/tenants").send(body());
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "A tenant with this slug already exists" });
  });

  it("a failed plan setup is the function's 502", async () => {
    H.provisioning = { ok: false, state: "FAILED_RETRYABLE", body: { error: "billing_unreachable" }, failureCode: "billing_unreachable" };
    const r = await request(app).post("/api/system/tenants").send(body());
    expect(r.status).toBe(502);
    expect(r.body.data.billing.canRepair).toBe(true);
  });

  it("an Authentik failure is a 500 with no detail", async () => {
    H.identityFails = true;
    const r = await request(app).post("/api/system/tenants").send(body());
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "Failed to create tenant" });
  });
});
