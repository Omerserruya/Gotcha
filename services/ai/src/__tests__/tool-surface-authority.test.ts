/**
 * Guardrail: the agent runtime toolbox must follow ONE authority —
 *   surface a catalog tool  IFF  (integration CONNECTED)  AND  (AgentToolPermission allowed)
 *   AND TenantTool enabled  AND  allowedModes ∋ the runtime mode.
 *
 * Neither layer may bypass the other. These tests pin the resolver
 * (`buildAgentToolsForAIAgent`) so a future change can't silently re-introduce
 * a hidden capability path (the Google-Calendar "enabled in UI but invisible"
 * class of bug).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../../packages/shared/src/lib/prisma", () => ({
  prisma: { agentToolPermission: { findMany: vi.fn() } },
}));

import { buildAgentToolsForAIAgent, prisma } from "@chatcenter/shared";

const ct = (slug: string, allowedModes: string[]) => ({
  description: null,
  usageRule: null,
  tenantTool: {
    catalogTool: { name: slug, description: `${slug} does a thing`, slug, allowedModes, inputSchema: null },
  },
});

describe("tool surface authority — connected AND allowed (single source of truth)", () => {
  beforeEach(() => {
    (prisma as any).agentToolPermission.findMany.mockReset().mockResolvedValue([]);
  });

  it("the resolver query requires isAllowed AND TenantTool.isEnabled AND integration CONNECTED", async () => {
    let where: any;
    (prisma as any).agentToolPermission.findMany.mockImplementation((args: any) => {
      where = args?.where;
      return Promise.resolve([]);
    });
    await buildAgentToolsForAIAgent("t1", "a1", { allowedMode: "AUTO" });
    // Authorization layer:
    expect(where?.isAllowed).toBe(true);
    expect(where?.aiAgentId).toBe("a1");
    // Capability layer:
    expect(where?.tenantTool?.isEnabled).toBe(true);
    expect(where?.tenantTool?.tenantIntegration?.status).toBe("CONNECTED");
  });

  it("AUTO surface drops ASSIST-only tools (allowedModes without AUTO)", async () => {
    (prisma as any).agentToolPermission.findMany.mockResolvedValue([
      ct("ok_tool", ["AUTO", "ASSIST"]),
      ct("assist_only", ["ASSIST"]),
    ]);
    const tools = await buildAgentToolsForAIAgent("t1", "a1", { allowedMode: "AUTO" });
    const names = (tools as any[]).map((t) => t.function?.name);
    expect(names).toContain("integration_ok_tool");
    expect(names).not.toContain("integration_assist_only");
  });

  it("no agent id → no integration tools surfaced (authorization absent)", async () => {
    await buildAgentToolsForAIAgent("t1", null, { allowedMode: "AUTO" });
    expect((prisma as any).agentToolPermission.findMany).not.toHaveBeenCalled();
  });
});
