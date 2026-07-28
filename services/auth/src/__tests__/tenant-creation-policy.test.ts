/**
 * Every organization has a plan, decided at creation.
 *
 * The removed option is the point of these tests. "No billing" used to be the
 * default on the create form, which made the least-effort path the one that
 * produced a fully-accessible organization with no commercial record of why -
 * and nothing downstream ever asked. Those tenants were then indistinguishable
 * from paying ones on every screen we have.
 *
 * So: the request cannot omit the decision, cannot name a third option, and
 * cannot half-specify either of the two.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTenantSchema } from "../routes/system";

const SRC = join(__dirname, "..");
const system = readFileSync(join(SRC, "routes/system.ts"), "utf8");

const WHO = { name: "Acme", slug: "acme", adminEmail: "a@acme.com", adminName: "A" };
const FUTURE = new Date(Date.now() + 30 * 86_400_000).toISOString();

const paid = (over: Record<string, unknown> = {}) => ({
  ...WHO,
  billing: { mode: "PAID_PLAN", planVersionId: "plan_123", ...over },
});
const poc = (over: Record<string, unknown> = {}) => ({
  ...WHO,
  billing: {
    mode: "POC",
    pocCredits: 5_000,
    pocExpiresAt: FUTURE,
    pocFeatureAreas: ["conversation"],
    ...over,
  },
});

describe("the commercial decision is mandatory", () => {
  it("refuses a tenant with no billing block at all", () => {
    expect(createTenantSchema.safeParse(WHO).success).toBe(false);
  });

  it("refuses NONE, the option that used to exist", () => {
    const r = createTenantSchema.safeParse({ ...WHO, billing: { mode: "NONE" } });
    expect(r.success).toBe(false);
  });

  it("refuses any mode outside the two", () => {
    for (const mode of ["TRIAL", "CUSTOM_PLAN", "MANUAL_CONTRACT", "FREE", ""]) {
      // Each of these is a real flow with its own rules elsewhere. Reaching
      // them through this route would apply none of those rules.
      expect(createTenantSchema.safeParse({ ...WHO, billing: { mode } }).success, mode).toBe(false);
    }
  });

  it("accepts exactly PAID_PLAN and POC", () => {
    expect(createTenantSchema.safeParse(paid()).success).toBe(true);
    expect(createTenantSchema.safeParse(poc()).success).toBe(true);
  });
});

describe("PAID_PLAN must name a plan and may not carry money", () => {
  it("requires a plan version", () => {
    expect(createTenantSchema.safeParse({ ...WHO, billing: { mode: "PAID_PLAN" } }).success).toBe(false);
  });

  it("rejects a smuggled price, credit or currency value", () => {
    // Not ignored - rejected. Silently dropping them would leave a caller
    // sending a price forever, and the next reader assuming it was used.
    for (const field of ["price", "amount", "credits", "currency", "snapshotPrice"]) {
      const r = createTenantSchema.safeParse(paid({ [field]: 1 }));
      expect(r.success, field).toBe(false);
    }
  });
});

describe("POC must be fully specified", () => {
  it("requires a credit budget", () => {
    const r = createTenantSchema.safeParse(poc({ pocCredits: undefined }));
    expect(r.success).toBe(false);
  });

  it("requires an expiry - an evaluation without an end is free product", () => {
    expect(createTenantSchema.safeParse(poc({ pocExpiresAt: undefined })).success).toBe(false);
  });

  it("requires at least one feature area", () => {
    // Empty would be read downstream as "all of them", because license
    // semantics treat an absent row as allowed.
    expect(createTenantSchema.safeParse(poc({ pocFeatureAreas: [] })).success).toBe(false);
    expect(createTenantSchema.safeParse(poc({ pocFeatureAreas: undefined })).success).toBe(false);
  });

  it("rejects a non-positive or absurd budget", () => {
    expect(createTenantSchema.safeParse(poc({ pocCredits: 0 })).success).toBe(false);
    expect(createTenantSchema.safeParse(poc({ pocCredits: -5 })).success).toBe(false);
    expect(createTenantSchema.safeParse(poc({ pocCredits: 10_000_000 })).success).toBe(false);
  });
});

describe("the route's own guarantees", () => {
  const create = system.slice(system.indexOf('router.post("/tenants"'), system.indexOf('router.post(\n  "/tenants/:id/activate-manual-contract"'));

  it("validates the POC expiry and feature areas BEFORE creating anything", () => {
    const beforeTenant = create.slice(0, create.indexOf("tx.tenant.create"));
    expect(beforeTenant).toContain("expiry_must_be_in_the_future");
    expect(beforeTenant).toContain("unknown_feature_domain");
  });

  it("makes the provisioning request durable before calling billing", () => {
    expect(create.indexOf("createProvisioningRequest")).toBeLessThan(create.indexOf("runProvisioning"));
  });

  it("returns a repairable state rather than an active unplanned tenant", () => {
    expect(create).toContain("Tenant created but plan setup did not complete");
    expect(create).toContain("canRepair");
    expect(create).toContain("paidAccessGranted: false");
  });

  it("never grants paid access on the paid path", () => {
    // The paid response says so explicitly, and no subscription or credit call
    // appears anywhere in this route.
    expect(create).not.toContain("setupPoc(");
    expect(create).not.toContain("grantUnits");
  });

  it("a plan-less tenant can be given a paid plan, but a paying one cannot be re-pointed", () => {
    const assign = system.slice(system.indexOf('router.post("/tenants/:id/assign-paid-plan"'));
    // Remediation for the empty case only. Re-pointing a live plan has an
    // existing subscription, a period and money already taken to reckon with,
    // and none of that happens here.
    expect(assign).toContain("TENANT_ALREADY_HAS_A_PLAN");
    expect(assign).toContain("resolveTenantPlanAccess");
    // The tenant is moved to PENDING_PAYMENT before billing is called, so a
    // failure leaves it denied rather than granted.
    expect(assign.indexOf('status: "PENDING_PAYMENT"')).toBeLessThan(assign.indexOf("runProvisioning"));
  });

  it("repair is reachable for a POC tenant, which is never PENDING_PAYMENT", () => {
    const repair = system.slice(system.indexOf('router.post("/tenants/:id/repair-billing-provisioning"'));
    // A POC tenant carries no payment state, so the paid-path status guard
    // would make a half-provisioned POC permanently unrepairable.
    expect(repair).toContain('status.mode !== "POC"');
  });
});
