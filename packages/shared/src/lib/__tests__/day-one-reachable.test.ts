import { describe, it, expect } from "vitest";
import { evaluateTenantAccess } from "../tenant-access-policy";

/**
 * Day one has to be reachable on day one.
 *
 * /api/setup/state and /api/knowledge/ingest/latest exist to tell a brand-new
 * workspace what to do next. They were behind the FULL_APPLICATION gate, which
 * asks for ACTIVE status AND a live plan - neither of which a workspace has
 * before it has finished setting up. The screen that explains the setup was
 * refused to everyone still doing it.
 */
const DAY_ONE_STATUSES = ["PENDING_ONBOARDING", "PENDING_PAYMENT"] as const;

describe("the day-one endpoints are reachable on day one", () => {
  it("FULL_APPLICATION refuses a workspace that is still onboarding", () => {
    // The bug, pinned so it cannot come back by someone 'tidying' the gate.
    for (const status of DAY_ONE_STATUSES) {
      expect(evaluateTenantAccess(status as any, "FULL_APPLICATION").allow).toBe(false);
    }
  });

  it("ONBOARDING admits exactly those workspaces", () => {
    for (const status of DAY_ONE_STATUSES) {
      expect(evaluateTenantAccess(status as any, "ONBOARDING").allow).toBe(true);
    }
  });

  it("ONBOARDING still admits an active workspace", () => {
    // Relaxing the gate must not cost the ordinary case.
    expect(evaluateTenantAccess("ACTIVE" as any, "ONBOARDING").allow).toBe(true);
  });

  it("ONBOARDING still refuses a suspended workspace", () => {
    // It is a narrower gate, not an open door: a suspended tenant may not
    // walk back in through the setup screen.
    expect(evaluateTenantAccess("SUSPENDED" as any, "ONBOARDING").allow).toBe(false);
  });

  it("a missing plan does not refuse the onboarding scope", () => {
    // FULL_APPLICATION asks the commercial question and a day-one tenant has
    // no plan to answer it with - which is how 402 TENANT_PLAN_REQUIRED
    // reached a screen whose whole job is to explain what to set up.
    const noPlan = { active: false, pendingPayment: false } as any;
    expect(evaluateTenantAccess("PENDING_ONBOARDING" as any, "ONBOARDING", noPlan).allow).toBe(true);
    expect(evaluateTenantAccess("ACTIVE" as any, "FULL_APPLICATION", noPlan).allow).toBe(false);
  });
});
