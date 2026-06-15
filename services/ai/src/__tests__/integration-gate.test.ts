/**
 * Verifies the tool gate handles adapter tool names (provider.tool) correctly.
 *
 * BUG REPRO: tool-gate.ts splits on "integration." prefix only, so an adapter
 * tool name like "stripe.refund_payment" is queried verbatim against
 * CatalogTool.slug - but the catalog stores `slug = "refund_payment"` (per the
 * 20260506100000_marketplace_real_integrations_only migration). The lookup
 * misses, the gate denies, and EVERY adapter tool is blocked in production.
 */

import { describe, it, expect, vi } from "vitest";

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
