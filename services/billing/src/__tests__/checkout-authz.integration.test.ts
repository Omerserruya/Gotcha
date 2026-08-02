/**
 * Whether this caller may see THIS checkout.
 *
 * A checkout reference travels through an email, a browser URL and a third
 * party. It identifies a checkout; it proves nothing about who is asking. The
 * rules were written and asserted at source level, but never driven with actual
 * identities - and the interesting failures here are all of the form "a valid
 * credential for one thing works on another".
 *
 * Driven against the real database, because the authorization reads real rows.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { prisma } from "@chatcenter/shared";

/** Identity for the next request, as `authenticate` would have attached it. */
let currentUser: Record<string, unknown> | null = null;

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    authenticate: (req: any, _res: any, next: any) => {
      if (currentUser) req.user = currentUser;
      next();
    },
    resolveTenant: (_req: any, _res: any, next: any) => next(),
  };
});

import express from "express";
import request from "supertest";
import checkoutRouter from "../routes/checkout";
import { issueContinuationLink } from "../services/continuation-link.service";

const RUN = `authz-${Date.now()}`;
const tenantIds: string[] = [];
const checkoutIds: string[] = [];
const userIds: string[] = [];
const identityIds: string[] = [];

/**
 * A request carrying a session.
 *
 * `optionalAuth` only runs authentication when an Authorization header is
 * present - a customer arriving from an email legitimately has none. So a
 * session-based test has to send one, or it is testing the anonymous path by
 * accident.
 */
function asUser(agent: any) {
  return agent.set("Authorization", "Bearer test-session");
}

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api", checkoutRouter);
  return a;
}

async function org(label: string) {
  const n = `${RUN}-${label}`;
  const tenant = await prisma.tenant.create({ data: { name: n, slug: n, status: "PENDING_PAYMENT" } });
  tenantIds.push(tenant.id);

  const checkout = await prisma.pendingCheckout.create({
    data: {
      reference: `chk_${n}`, tenantId: tenant.id,
      planKey: "ai_workforce", planVersion: 1,
      snapshotPrice: 499, snapshotCurrency: "USD", snapshotIncludedCredits: 2000,
      amount: 499, currency: "USD", status: "PENDING",
      expiresAt: new Date(Date.now() + 3_600_000),
      idempotencyKey: `checkout:chk_${n}`,
    },
  });
  checkoutIds.push(checkout.id);

  // A User belongs to an Identity (the person) and a Tenant (the organization).
  // Both are needed, because the authorization check is a real lookup joining
  // the two - which is the point of driving it against the database rather than
  // stubbing the answer.
  const identity = await prisma.identity.create({
    data: { authentikSubject: `sub-${n}`, email: `${n}@example.test`, name: label },
  });
  identityIds.push(identity.id);

  const user = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      identityId: identity.id,
      email: `${n}@example.test`,
      name: label,
      role: "ADMIN",
    },
  });
  userIds.push(user.id);

  const link = await issueContinuationLink({ checkoutId: checkout.id, tenantId: tenant.id });
  return { tenant, checkout, user, token: link.token };
}

let acme: Awaited<ReturnType<typeof org>>;
let rival: Awaited<ReturnType<typeof org>>;

beforeAll(async () => {
  acme = await org("acme");
  rival = await org("rival");
});

afterAll(async () => {
  await prisma.paymentContinuationLink.deleteMany({ where: { tenantId: { in: tenantIds } } });
  // Scoped by tenant: the cross-tenant guard refuses an unscoped User query,
  // which is the isolation net working rather than an inconvenience.
  await prisma.user.deleteMany({ where: { tenantId: { in: tenantIds }, id: { in: userIds } } });
  await prisma.identity.deleteMany({ where: { id: { in: identityIds } } });
  await prisma.pendingCheckout.deleteMany({ where: { id: { in: checkoutIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
});

describe("a credential for one checkout does not work on another", () => {
  it("refuses a continuation token issued for a different checkout", async () => {
    currentUser = null;
    // The dangerous shape: a completely valid, unexpired, unrevoked token -
    // just not for this checkout.
    const res = await request(app()).get(
      `/api/checkout/${acme.checkout.reference}/status?token=${rival.token}`,
    );
    expect(res.status).toBe(404);
  });

  it("accepts the token that belongs to it", async () => {
    currentUser = null;
    const res = await request(app()).get(
      `/api/checkout/${acme.checkout.reference}/status?token=${acme.token}`,
    );
    // Proves the refusal above is discriminating, not blanket.
    expect(res.status).toBe(200);
    expect(res.body.data.reference).toBe(acme.checkout.reference);
  });

  it("refuses a member of a different organization", async () => {
    // A real, authenticated customer of the product - with no relationship to
    // this checkout.
    currentUser = { userId: rival.user.id, role: "ADMIN", tenantId: rival.tenant.id };
    const res = await asUser(request(app()).get(`/api/checkout/${acme.checkout.reference}/status`));
    expect(res.status).toBe(404);
  });

  it("accepts a member of the organization it belongs to", async () => {
    currentUser = { userId: acme.user.id, role: "ADMIN", tenantId: acme.tenant.id };
    const res = await asUser(request(app()).get(`/api/checkout/${acme.checkout.reference}/status`));
    expect(res.status).toBe(200);
  });

  it("refuses an anonymous caller who merely knows the reference", async () => {
    currentUser = null;
    // The reference travels through an email and a third party. Knowing it is
    // not authorization.
    const res = await request(app()).get(`/api/checkout/${acme.checkout.reference}/status`);
    expect(res.status).toBe(404);
  });

  it("refuses a garbage token rather than falling through to the session", async () => {
    currentUser = { userId: acme.user.id, role: "ADMIN", tenantId: acme.tenant.id };
    const res = await asUser(
      request(app()).get(`/api/checkout/${acme.checkout.reference}/status?token=not-a-real-token-at-all`),
    );
    // A supplied token is the claim being made. Silently ignoring a bad one and
    // authorizing by session instead would make a forged token indistinguishable
    // from none.
    expect(res.status).toBe(404);
  });
});

describe("refusals are indistinguishable from a missing checkout", () => {
  it("returns the same body for unauthorized and unknown", async () => {
    currentUser = null;
    const unauthorized = await request(app()).get(`/api/checkout/${acme.checkout.reference}/status`);
    const unknown = await request(app()).get("/api/checkout/chk_does_not_exist/status");
    // Otherwise a caller can probe which references are real.
    expect(unauthorized.status).toBe(unknown.status);
    expect(unauthorized.body).toEqual(unknown.body);
  });

  it("rejects a reference that is not even shaped like one, the same way", async () => {
    currentUser = null;
    const res = await request(app()).get("/api/checkout/../../etc/passwd/status");
    expect([404, 400]).toContain(res.status);
  });
});

describe("a platform admin can look without belonging", () => {
  it("is allowed, because support needs to see it", async () => {
    currentUser = { userId: "sys1", role: "SYSTEM_ADMIN" };
    const res = await asUser(request(app()).get(`/api/checkout/${acme.checkout.reference}/status`));
    expect(res.status).toBe(200);
  });
});

describe("the response tells a customer nothing internal", () => {
  it("carries no provider, tenant or attempt identifiers", async () => {
    currentUser = null;
    const res = await request(app()).get(
      `/api/checkout/${acme.checkout.reference}/status?token=${acme.token}`,
    );
    const body = JSON.stringify(res.body);
    for (const leak of ["tenantId", "attemptKey", "providerChargeRef", "paymentQuoteId", "idempotencyKey", "tokenHash"]) {
      expect(body, `must not expose ${leak}`).not.toContain(leak);
    }
    // ...while still carrying what the customer needs.
    expect(res.body.data.amount).toBe("499");
    expect(res.body.data.planName).toBeTruthy();
  });
});
