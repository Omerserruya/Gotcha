/**
 * Nothing downstream silently re-blocks a high-risk tool the workspace chose to
 * run without approval (Omer, 2026-10-12).
 *
 * Every dispatch path - the bot's tool calls, the orchestrator, the kernel
 * approval gate and the copilot - asks ONE function, evaluatePolicies, and it
 * treats the tenant's override as authoritative in both directions. So the
 * choice stored by PUT /api/tool-permissions (configOverrides.hitlPolicy.mode
 * "never") must come back ALLOW for a catalog "always" HIGH tool, and the
 * catalog default must still ask when there is no override.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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

const CATALOG_ALWAYS = { mode: "always", approverRole: "ADMIN", notifyChannels: ["in_app"], expiresAfterMin: 60, allowModification: true };

function coupon(overrides: Record<string, unknown>) {
  (prisma as any).tenantTool.findFirst.mockResolvedValue({
    id: "tt1",
    isEnabled: true,
    catalogTool: { hitlPolicy: CATALOG_ALWAYS },
    tenantIntegration: { status: "CONNECTED", integration: { slug: "woocommerce" } },
  });
  (prisma as any).tenantTool.findUnique.mockResolvedValue({ configOverrides: overrides, isEnabled: true });
}

beforeEach(() => {
  (prisma as any).tenantTool.findFirst.mockReset();
  (prisma as any).tenantTool.findUnique.mockReset();
});

describe("★ the gate honours the workspace's choice on a HIGH financial tool", () => {
  it("ALLOWS woocommerce.create_coupon once the tenant set it to Execute", async () => {
    coupon({ hitlPolicy: { mode: "never" } });
    const r = await evaluatePolicies({ tenantId: "t1", toolName: "woocommerce.create_coupon" });
    expect(r.decision).toBe("ALLOW");
    expect(r.reason).toContain("catalog=always");
    expect(r.reason).toContain("tenant=never");
  });

  it("still asks by default: no override means the catalog's 'always'", async () => {
    coupon({});
    const r = await evaluatePolicies({ tenantId: "t1", toolName: "woocommerce.create_coupon" });
    expect(r.decision).toBe("REQUIRE_APPROVAL");
  });

  it("asks again once the tenant sets it back to Ask me", async () => {
    coupon({ hitlPolicy: { mode: "always" } });
    const r = await evaluatePolicies({ tenantId: "t1", toolName: "woocommerce.create_coupon" });
    expect(r.decision).toBe("REQUIRE_APPROVAL");
  });
});
