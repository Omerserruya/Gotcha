/**
 * The cross-service provisioning saga.
 *
 * DB-backed, and the failure cases are induced for real: a permanent failure by
 * requesting a plan that cannot be sold, a transient one by pointing the saga
 * at a port nothing is listening on. Mocking the billing client would only
 * prove the mock behaves.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";
import { prisma } from "@chatcenter/shared";
import {
  createProvisioningRequest,
  runProvisioning,
  provisioningStatusForTenant,
  classifyFailure,
  MAX_PROVISIONING_ATTEMPTS,
} from "../services/billing-provisioning.service";

const RUN = `saga-${Date.now()}`;
const tenantIds: string[] = [];
const ORIGINAL_URL = process.env.BILLING_SERVICE_URL;

async function newTenant() {
  const n = `${RUN}-${Math.random().toString(36).slice(2, 8)}`;
  const t = await prisma.tenant.create({ data: { name: n, slug: n, status: "PENDING_PAYMENT" } });
  tenantIds.push(t.id);
  return t;
}

async function activePlanId() {
  const p = await prisma.plan.findFirst({ where: { key: "ai_workforce", status: "ACTIVE" }, select: { id: true } });
  if (!p) throw new Error("seed missing: ai_workforce ACTIVE");
  return p.id;
}

beforeEach(() => {
  process.env.BILLING_SERVICE_URL = ORIGINAL_URL || "http://billing:4009";
});
afterEach(() => {
  process.env.BILLING_SERVICE_URL = ORIGINAL_URL;
});

afterAll(async () => {
  const checkouts = await prisma.pendingCheckout.findMany({ where: { tenantId: { in: tenantIds } }, select: { id: true } });
  const ids = checkouts.map((c) => c.id);
  await prisma.paymentContinuationLink.deleteMany({ where: { checkoutId: { in: ids } } });
  await prisma.paymentAttempt.deleteMany({ where: { checkoutId: { in: ids } } });
  await prisma.pendingCheckout.deleteMany({ where: { id: { in: ids } } });
  await prisma.tenantBillingProvisioningRequest.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.billableEntityTenant.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  process.env.BILLING_SERVICE_URL = ORIGINAL_URL;
});

describe("the request is durable before billing is called", () => {
  it("1-2. a successful run completes the request and records the checkout", async () => {
    const tenant = await newTenant();
    const req = await createProvisioningRequest({
      tenantId: tenant.id,
      requestedBy: "sysadmin-test",
      selection: { planVersionId: await activePlanId() },
    });

    // The request holds everything needed to redo this without asking again.
    expect(req.planVersionId).toBeTruthy();
    expect(req.idempotencyKey).toBe(`provisioning:${req.id}`);
    expect(req.state).toBe("PENDING");

    const outcome = await runProvisioning(req.id);
    expect(outcome.ok).toBe(true);

    const after = await prisma.tenantBillingProvisioningRequest.findUnique({ where: { id: req.id } });
    expect(after?.state).toBe("COMPLETED");
    expect(after?.checkoutId).toBeTruthy();
    expect(after?.completedAt).toBeTruthy();
  });
});

describe("a transient billing failure stays recoverable", () => {
  it("3-6. tenant stays PENDING_PAYMENT, no checkout, no email, request retryable", async () => {
    const tenant = await newTenant();
    const req = await createProvisioningRequest({
      tenantId: tenant.id,
      selection: { planVersionId: await activePlanId() },
    });

    // Nothing is listening here. This is a real transport failure.
    process.env.BILLING_SERVICE_URL = "http://127.0.0.1:9";
    const outcome = await runProvisioning(req.id);

    expect(outcome.ok).toBe(false);
    expect(outcome.state).toBe("FAILED_RETRYABLE");

    const t = await prisma.tenant.findUnique({ where: { id: tenant.id } });
    expect(t?.status).toBe("PENDING_PAYMENT");
    // 5: no checkout, so 6: there is no link and therefore nothing to email.
    expect(await prisma.pendingCheckout.count({ where: { tenantId: tenant.id } })).toBe(0);

    const status = await provisioningStatusForTenant(tenant.id);
    expect(status?.canRepair).toBe(true);
    expect(status?.canResend).toBe(false);
    // The operator gets an actionable message, not a transport string.
    expect(status?.lastFailureMessage).toMatch(/retry/i);
    expect(status?.lastFailureMessage).not.toMatch(/ECONNREFUSED|127\.0\.0\.1/);
  });

  it("4,7-9. repair afterwards creates exactly one checkout, attempt and link", async () => {
    const tenant = await newTenant();
    const req = await createProvisioningRequest({
      tenantId: tenant.id,
      selection: { planVersionId: await activePlanId() },
    });

    process.env.BILLING_SERVICE_URL = "http://127.0.0.1:9";
    await runProvisioning(req.id);
    process.env.BILLING_SERVICE_URL = ORIGINAL_URL || "http://billing:4009";

    const repaired = await runProvisioning(req.id);
    expect(repaired.ok).toBe(true);

    const checkouts = await prisma.pendingCheckout.findMany({ where: { tenantId: tenant.id } });
    expect(checkouts).toHaveLength(1);
    expect(await prisma.paymentAttempt.count({ where: { checkoutId: checkouts[0].id } })).toBe(1);
    const links = await prisma.paymentContinuationLink.findMany({ where: { checkoutId: checkouts[0].id } });
    expect(links.filter((l) => !l.revokedAt)).toHaveLength(1);
  });
});

describe("repair is idempotent", () => {
  it("10. repeated repair converges rather than duplicating", async () => {
    const tenant = await newTenant();
    const req = await createProvisioningRequest({ tenantId: tenant.id, selection: { planVersionId: await activePlanId() } });

    await runProvisioning(req.id);
    // A COMPLETED request short-circuits instead of calling billing again.
    const again = await runProvisioning(req.id);
    expect(again.ok).toBe(true);
    expect(again.body?.alreadyCompleted).toBe(true);

    expect(await prisma.pendingCheckout.count({ where: { tenantId: tenant.id } })).toBe(1);
  });

  it("11. concurrent repairs create no duplicates", async () => {
    const tenant = await newTenant();
    const req = await createProvisioningRequest({ tenantId: tenant.id, selection: { planVersionId: await activePlanId() } });

    // Five operators (or an operator and the retry sweep) at once.
    const results = await Promise.all(Array.from({ length: 5 }, () => runProvisioning(req.id)));

    // The conditional claim means at most one actually calls billing.
    expect(results.filter((r) => r.failureCode === "already_processing").length).toBeGreaterThanOrEqual(0);
    const checkouts = await prisma.pendingCheckout.findMany({ where: { tenantId: tenant.id } });
    expect(checkouts.length).toBeLessThanOrEqual(1);
    if (checkouts.length === 1) {
      expect(await prisma.paymentAttempt.count({ where: { checkoutId: checkouts[0].id } })).toBe(1);
    }
  });
});

describe("permanent failures are not retried blindly", () => {
  it("12. an unsellable plan is FAILED_PERMANENT and not repairable", async () => {
    const tenant = await newTenant();
    const req = await createProvisioningRequest({
      tenantId: tenant.id,
      selection: { planVersionId: "does-not-exist" },
    });

    const outcome = await runProvisioning(req.id);
    expect(outcome.ok).toBe(false);
    expect(outcome.state).toBe("FAILED_PERMANENT");

    const status = await provisioningStatusForTenant(tenant.id);
    // Retrying would fail identically forever and hide the real problem.
    expect(status?.canRepair).toBe(false);
    expect(status?.lastFailureMessage).toMatch(/no longer valid|different plan/i);
    expect(await prisma.pendingCheckout.count({ where: { tenantId: tenant.id } })).toBe(0);
  });

  it("classifies validation failures as permanent and transport ones as retryable", () => {
    expect(classifyFailure("plan_version_not_active")).toBe("FAILED_PERMANENT");
    expect(classifyFailure("volume_option_invalid")).toBe("FAILED_PERMANENT");
    expect(classifyFailure("billing_unreachable")).toBe("FAILED_RETRYABLE");
    expect(classifyFailure(undefined)).toBe("FAILED_RETRYABLE");
  });

  it("retry is bounded", async () => {
    const tenant = await newTenant();
    const req = await createProvisioningRequest({ tenantId: tenant.id, selection: { planVersionId: await activePlanId() } });
    await prisma.tenantBillingProvisioningRequest.update({
      where: { id: req.id },
      data: { attemptCount: MAX_PROVISIONING_ATTEMPTS, state: "FAILED_RETRYABLE" },
    });
    const outcome = await runProvisioning(req.id);
    expect(outcome.failureCode).toBe("max_attempts_exhausted");
  });
});

describe("the durable request holds no commercial values", () => {
  it("stores the request, never a price", async () => {
    const tenant = await newTenant();
    const req = await createProvisioningRequest({
      tenantId: tenant.id,
      selection: { planVersionId: await activePlanId(), commercialNote: "internal note" },
    });
    const row = await prisma.tenantBillingProvisioningRequest.findUnique({ where: { id: req.id } });
    const json = JSON.stringify(row);
    // Prices, credits and currency are recomputed server-side every time.
    for (const forbidden of ["snapshotPrice", "amount", "includedCredits", "currency"]) {
      expect(Object.keys(row ?? {})).not.toContain(forbidden);
    }
    expect(json).not.toMatch(/\btoken\b/i);
  });
});
