/**
 * Verifies the tool gate handles adapter tool names (provider.tool) correctly.
 *
 * BUG REPRO: tool-gate.ts splits on "integration." prefix only, so an adapter
 * tool name like "stripe.refund_payment" is queried verbatim against
 * CatalogTool.slug - but the catalog stores `slug = "refund_payment"` (per the
 * 20260506100000_marketplace_real_integrations_only migration). The lookup
 * misses, the gate denies, and EVERY adapter tool is blocked in production.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the prisma module that tool-gate.ts internally imports via its
// relative `./prisma` path. The string here is the resolved absolute module
// id; vitest catches both this deep reference AND the package re-export so
// the test's `import { prisma } from "@chatcenter/shared"` below sees the
// same mocked object. String-literal - no TS path resolution constraint.
vi.mock("../../../../packages/shared/src/lib/prisma", () => ({
  prisma: {
    tenantTool: { findFirst: vi.fn(), findUnique: vi.fn() },
    tenantToolPermission: { findUnique: vi.fn().mockResolvedValue(null) },
    agentToolPermission: { findFirst: vi.fn().mockResolvedValue(null) },
    customApiTool: { findUnique: vi.fn().mockResolvedValue(null) },
    customDbQueryTool: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

import { evaluatePolicies, prisma } from "@chatcenter/shared";

describe("tool-gate adapter-tool routing", () => {
  it("RESOLVES `stripe.refund_payment` against catalog by integration+slug", async () => {
    let lookupArg: any = null;
    (prisma as any).tenantTool.findFirst.mockImplementation((args: any) => {
      lookupArg = args;
      // Simulate two CatalogTool rows with the same slug across integrations.
      // The CORRECT lookup should disambiguate via integration.slug; otherwise
      // the gate could pick stripe's policy when the call is square's, etc.
      const where = args?.where?.catalogTool;
      if (!where) return null;
      // Honour disambiguation when present.
      if (where?.integration?.slug === "stripe" && where?.slug === "refund_payment") {
        return { id: "tt1", isEnabled: true, catalogTool: { hitlPolicy: { mode: "always" } } };
      }
      // Naive lookup that matches by slug only - returns the WRONG row.
      if (where?.slug === "refund_payment" || where?.slug === "stripe.refund_payment") {
        return null;
      }
      return null;
    });
    (prisma as any).tenantTool.findUnique.mockResolvedValue({ configOverrides: {}, isEnabled: true });

    const r = await evaluatePolicies({ tenantId: "t1", toolName: "stripe.refund_payment" });
    expect(r.decision).toBe("REQUIRE_APPROVAL");
    // The lookup must include both integration slug AND tool slug.
    expect(lookupArg?.where?.catalogTool?.slug).toBe("refund_payment");
    expect(lookupArg?.where?.catalogTool?.integration?.slug).toBe("stripe");
  });
});

describe("tool-gate vendor-neutral + custom tools (no CatalogTool row)", () => {
  // BUG REPRO: `integration_create_lead` / `custom.*` / `custom_db.*` have NO
  // CatalogTool row by design. The dynamic catalog branch returned DENY for
  // them ("no tenant tool for …"), silently breaking the autonomous bot:
  //   - semantic create-lead denied for every generic-CRM tenant (Airtable/…)
  //   - every custom HTTP / DB tool denied always.

  beforeEach(() => {
    (prisma as any).tenantTool.findFirst.mockReset();
    (prisma as any).tenantTool.findUnique.mockReset();
    (prisma as any).customApiTool.findUnique.mockReset().mockResolvedValue(null);
    (prisma as any).customDbQueryTool.findUnique.mockReset().mockResolvedValue(null);
    (prisma as any).tenantToolPermission.findUnique.mockResolvedValue(null);
  });

  it("ALLOWS integration_create_lead even when the tenant has NO create_lead CatalogTool", async () => {
    (prisma as any).tenantTool.findFirst.mockResolvedValue(null); // generic-CRM tenant
    const r = await evaluatePolicies({ tenantId: "t1", toolName: "integration_create_lead" });
    expect(r.decision).toBe("ALLOW");
    // Must NOT have routed into the catalog-required branch.
    expect((prisma as any).tenantTool.findFirst).not.toHaveBeenCalled();
  });

  it("ALLOWS integration_create_contact (same vendor-neutral floor)", async () => {
    const r = await evaluatePolicies({ tenantId: "t1", toolName: "integration_create_contact" });
    expect(r.decision).toBe("ALLOW");
  });

  it("AUTO-RUNS a read-only / low-risk custom API tool", async () => {
    (prisma as any).customApiTool.findUnique.mockResolvedValue({
      isActive: true, category: "READ", riskLevel: "LOW",
    });
    const r = await evaluatePolicies({ tenantId: "t1", toolName: "custom.order_status" });
    expect(r.decision).toBe("ALLOW");
  });

  it("REQUIRES APPROVAL for a write/high-risk custom API tool", async () => {
    (prisma as any).customApiTool.findUnique.mockResolvedValue({
      isActive: true, category: "WRITE", riskLevel: "MEDIUM",
    });
    const r = await evaluatePolicies({ tenantId: "t1", toolName: "custom.create_order" });
    expect(r.decision).toBe("REQUIRE_APPROVAL");
  });

  it("REQUIRES APPROVAL for a HIGH-risk custom DB tool even if READ", async () => {
    (prisma as any).customDbQueryTool.findUnique.mockResolvedValue({
      isActive: true, category: "READ", riskLevel: "HIGH",
    });
    const r = await evaluatePolicies({ tenantId: "t1", toolName: "custom_db.sensitive_lookup" });
    expect(r.decision).toBe("REQUIRE_APPROVAL");
  });

  it("DENIES an unknown / inactive custom tool (never auto-runs)", async () => {
    (prisma as any).customApiTool.findUnique.mockResolvedValue(null);
    const r = await evaluatePolicies({ tenantId: "t1", toolName: "custom.ghost" });
    expect(r.decision).toBe("DENY");
  });
});
