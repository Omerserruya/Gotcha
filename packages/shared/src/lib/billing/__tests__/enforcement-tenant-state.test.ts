/**
 * The AI runtime gate, and the organization's own state.
 *
 * The gap this covers: a tenant provisioned on a paid plan has no subscription
 * until its first payment is confirmed, because activation is what creates one.
 * The gate read "no subscription yet" as unlimited access - so such a tenant was
 * locked out of the application while its bot answered customers for free,
 * indefinitely. The paid product was, in the only way that matters, optional.
 */
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { prisma } from "../../prisma";
import { checkAiAllowed, assertAiAllowed, AiUnitsExhaustedError } from "../enforcement";

const RUN = `enf-${Date.now()}`;
const tenantIds: string[] = [];
const entityIds: string[] = [];
const ORIGINAL = { ...process.env };

async function tenant(status: any, opts: { withSubscription?: boolean } = {}) {
  const n = `${RUN}-${Math.random().toString(36).slice(2, 8)}`;
  const t = await prisma.tenant.create({ data: { name: n, slug: n, status } });
  const e = await prisma.billableEntity.create({ data: { displayName: n } });
  await prisma.billableEntityTenant.create({ data: { billableEntityId: e.id, tenantId: t.id } });
  tenantIds.push(t.id);
  entityIds.push(e.id);

  if (opts.withSubscription) {
    await prisma.subscription.create({
      data: {
        billableEntityId: e.id,
        planKey: "ai_workforce",
        planVersion: 1,
        status: "ACTIVE",
        enforcementEnabled: true,
        snapshotPrice: 499,
        snapshotCurrency: "USD",
        snapshotIncludedCredits: 2000,
      },
    });
  }
  return t;
}

beforeEach(() => {
  process.env.BILLING_ENFORCEMENT_MODE = "hard";
});

afterAll(async () => {
  await prisma.subscription.deleteMany({ where: { billableEntityId: { in: entityIds } } });
  await prisma.billableEntityTenant.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  process.env = { ...ORIGINAL };
});

describe("an organization that has not paid gets no AI", () => {
  it("refuses a PENDING_PAYMENT tenant even with no subscription", async () => {
    const t = await tenant("PENDING_PAYMENT");
    const res = await checkAiAllowed(t.id);
    // Previously: no subscription meant unlimited. The tenant was locked out of
    // the app while its bot kept serving customers.
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe("payment_required");
  });

  it("refuses a SUSPENDED tenant", async () => {
    const t = await tenant("SUSPENDED");
    const res = await checkAiAllowed(t.id);
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe("tenant_suspended");
  });

  it("throws for the callers that assert", async () => {
    const t = await tenant("PENDING_PAYMENT");
    await expect(assertAiAllowed(t.id)).rejects.toBeInstanceOf(AiUnitsExhaustedError);
  });

  it("distinguishes not having paid from having run out", async () => {
    const unpaid = await tenant("PENDING_PAYMENT");
    // Two different conversations to have with a customer: "your plan is not
    // active" and "you have used your credits".
    expect((await checkAiAllowed(unpaid.id)).reason).toBe("payment_required");
    expect((await checkAiAllowed(unpaid.id)).reason).not.toBe("units_exhausted");
  });
});

describe("it does not break anyone who should be served", () => {
  it("REFUSES an active tenant with no subscription", async () => {
    const t = await tenant("ACTIVE");
    // This reverses the earlier rule, deliberately and on instruction.
    //
    // It used to allow this case, reasoning that free and pre-billing tenants
    // legitimately have no subscription. The cost of that reasoning was that
    // "no subscription" and "paid customer" were served identically, so an
    // organization that never paid was indistinguishable from one that did.
    //
    // The blast radius is real: every ACTIVE tenant with no subscription row
    // loses paid functionality. That is what audit mode and the enforcement
    // impact report are for - measure it, then switch it on.
    const res = await checkAiAllowed(t.id);
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe("no_subscription");
  });

  it("allows a tenant still onboarding", async () => {
    const t = await tenant("PENDING_ONBOARDING");
    // Onboarding has no subscription yet by definition, and it is the flow
    // through which one gets bought. Refusing it here would make the product
    // impossible to start using. The paid product stays out of reach anyway -
    // the tenant access matrix denies that scope for this status.
    expect((await checkAiAllowed(t.id)).allowed).toBe(true);
  });

  it("allows an ACTIVE tenant with a live subscription and credits", async () => {
    const t = await tenant("ACTIVE", { withSubscription: true });
    const res = await checkAiAllowed(t.id);
    // No credits granted here, so this asserts only that the tenant-state check
    // did not short-circuit the normal path.
    expect(res.reason).not.toBe("payment_required");
    expect(res.reason).not.toBe("tenant_suspended");
  });

  it("stays open when the enforcement mode is off", async () => {
    process.env.BILLING_ENFORCEMENT_MODE = "off";
    const t = await tenant("PENDING_PAYMENT");
    expect((await checkAiAllowed(t.id)).allowed).toBe(true);
  });

  it("observes without blocking in soft mode", async () => {
    process.env.BILLING_ENFORCEMENT_MODE = "soft";
    const t = await tenant("PENDING_PAYMENT");
    const res = await checkAiAllowed(t.id);
    // The mode exists so enforcement can be switched on gradually. A new denial
    // reason must not become a hard outage the moment it ships.
    expect(res.allowed).toBe(true);
    expect(res.wouldBlock).toBe(true);
    expect(res.reason).toBe("payment_required");
  });
});
