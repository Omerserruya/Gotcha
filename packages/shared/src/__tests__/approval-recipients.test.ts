/**
 * Who may be pinged for an approval, and who may actually decide it.
 *
 * The rule these lock down: approval authority is EXPLICIT and RE-CHECKED.
 * There is no "fall back to an admin" path, because routing a refund approval
 * to whoever happens to be an admin is how the wrong person authorises money
 * movement. And a notification sitting on a phone proves nothing about the
 * tapper's current standing, so authorisation is verified again at decision
 * time.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const db: { recipient: any; user: any } = { recipient: null, user: null };
vi.mock("../lib/prisma", () => ({
  prisma: {
    approvalRecipient: { findFirst: vi.fn(async () => db.recipient) },
    user: { findFirst: vi.fn(async ({ where }: any) => {
      const u = db.user;
      if (!u) return null;
      if (where.id && where.id !== u.id) return null;
      if (where.tenantId && where.tenantId !== u.tenantId) return null;
      if (where.isActive && !u.isActive) return null;
      return u;
    }) },
  },
  withCrossTenantAccess: (fn: any) => fn(),
  crossTenantMiddleware: {},
}));
const hasPermission = vi.fn(async () => false);
vi.mock("../lib/permissions", () => ({ hasPermission: (...a: any[]) => hasPermission(...(a as [])) }));

const { resolveApprovalRecipient, userMayApprove, recipientRejectionMessage } =
  await import("../lib/approval-recipients");

const TENANT = "tenant-1";
const activeAdmin = { id: "user-9", name: "Dana", isActive: true, tenantId: TENANT, role: "ADMIN" };
const enabledRow = (over: any = {}) => ({
  enabled: true, phoneE164: "+972501234567", maxRiskLevel: "medium",
  user: activeAdmin, ...over,
});

beforeEach(() => {
  db.recipient = null; db.user = activeAdmin;
  hasPermission.mockReset(); hasPermission.mockResolvedValue(false);
});

describe("resolveApprovalRecipient", () => {
  it("returns not_configured when the tenant never set one up - NO admin fallback", async () => {
    db.recipient = null;
    const r = await resolveApprovalRecipient(TENANT);
    expect(r).toEqual({ ok: false, reason: "not_configured" });
  });

  it("respects the enabled switch (opt-in, off by default)", async () => {
    db.recipient = enabledRow({ enabled: false });
    expect(await resolveApprovalRecipient(TENANT)).toEqual({ ok: false, reason: "disabled" });
  });

  it("refuses a recipient with no usable phone number", async () => {
    db.recipient = enabledRow({ phoneE164: "" });
    expect(await resolveApprovalRecipient(TENANT)).toEqual({ ok: false, reason: "no_phone" });
  });

  it("refuses a membership that is no longer active", async () => {
    db.recipient = enabledRow({ user: { ...activeAdmin, isActive: false } });
    expect(await resolveApprovalRecipient(TENANT)).toEqual({ ok: false, reason: "membership_inactive" });
  });

  it("refuses a membership belonging to a DIFFERENT tenant", async () => {
    db.recipient = enabledRow({ user: { ...activeAdmin, tenantId: "other-tenant" } });
    expect(await resolveApprovalRecipient(TENANT)).toEqual({ ok: false, reason: "membership_inactive" });
  });

  it("refuses a recipient without approval permission (e.g. demoted to AGENT)", async () => {
    db.recipient = enabledRow({ user: { ...activeAdmin, role: "AGENT" } });
    db.user = { ...activeAdmin, role: "AGENT" };
    expect(await resolveApprovalRecipient(TENANT)).toEqual({ ok: false, reason: "not_authorized" });
  });

  it("holds back actions above the recipient's risk ceiling", async () => {
    db.recipient = enabledRow({ maxRiskLevel: "medium" });
    expect(await resolveApprovalRecipient(TENANT, { riskLevel: "high" }))
      .toEqual({ ok: false, reason: "risk_too_high" });
    // …but allows what is within the ceiling.
    const ok = await resolveApprovalRecipient(TENANT, { riskLevel: "low" });
    expect(ok.ok).toBe(true);
  });

  it("returns the recipient when everything checks out", async () => {
    db.recipient = enabledRow();
    const r = await resolveApprovalRecipient(TENANT, { riskLevel: "medium" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recipient).toMatchObject({ userId: "user-9", phoneE164: "+972501234567" });
  });

  it("every rejection has an actionable operator message (no silent skips)", () => {
    for (const reason of ["not_configured","disabled","no_phone","membership_inactive","not_authorized","risk_too_high"] as const) {
      const msg = recipientRejectionMessage(reason);
      expect(msg.length).toBeGreaterThan(20);
    }
  });
});

describe("userMayApprove (re-checked at decision time)", () => {
  it("grants when the fine-grained permission is held", async () => {
    db.user = { ...activeAdmin, role: "AGENT" };
    hasPermission.mockResolvedValue(true);
    expect(await userMayApprove(TENANT, "user-9")).toBe(true);
  });

  it("falls back to the ADMIN role when the permission set is unlicensed", async () => {
    db.user = activeAdmin;
    hasPermission.mockResolvedValue(false);
    expect(await userMayApprove(TENANT, "user-9")).toBe(true);
  });

  it("denies a plain AGENT with no permission", async () => {
    db.user = { ...activeAdmin, role: "AGENT" };
    expect(await userMayApprove(TENANT, "user-9")).toBe(false);
  });

  it("denies a user who has been deactivated since the message was sent", async () => {
    db.user = { ...activeAdmin, isActive: false };
    expect(await userMayApprove(TENANT, "user-9")).toBe(false);
  });

  it("denies across tenants", async () => {
    db.user = activeAdmin;
    expect(await userMayApprove("other-tenant", "user-9")).toBe(false);
  });

  it("denies when the permission layer throws and the role is not privileged", async () => {
    db.user = { ...activeAdmin, role: "AGENT" };
    hasPermission.mockRejectedValue(new Error("permission service down"));
    expect(await userMayApprove(TENANT, "user-9")).toBe(false);
  });
});
