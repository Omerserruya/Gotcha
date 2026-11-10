/**
 * Demo Factory 2026-11-10: an employee created through POST /api/ai-agents got
 * 0 tool permissions (no product search, no cards); the hiring builder grants
 * the safe tools of connected integrations. One rule, both paths.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ tools: [] as any[], created: [] as any[] }));
vi.mock("@chatcenter/shared", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    prisma: {
      ...actual.prisma,
      tenantTool: { findMany: vi.fn(async (a: any) => H.tools.filter((t) => t.tenantId === a.where.tenantId && t.connected && t.isEnabled)) },
      agentToolPermission: { createMany: vi.fn(async (a: any) => { H.created.push(...a.data); return { count: a.data.length }; }) },
    },
  };
});

import { grantConnectedSafeTools } from "../services/agent-builder.service";
import { readFileSync } from "node:fs";
import { join } from "node:path";

beforeEach(() => {
  H.created = [];
  H.tools = [
    { id: "tt_list", tenantId: "T", connected: true, isEnabled: true, catalogTool: { riskLevel: "low" } },
    { id: "tt_order", tenantId: "T", connected: true, isEnabled: true, catalogTool: { riskLevel: "medium" } },
    { id: "tt_refund", tenantId: "T", connected: true, isEnabled: true, catalogTool: { riskLevel: "high" } },
    { id: "tt_delete", tenantId: "T", connected: true, isEnabled: true, catalogTool: { riskLevel: "critical" } },
    { id: "tt_other", tenantId: "X", connected: true, isEnabled: true, catalogTool: { riskLevel: "low" } },
  ];
});

describe("a new employee's day-one tools", () => {
  it("every safe tool of a connected integration; never high or critical; never another tenant's", async () => {
    expect(await grantConnectedSafeTools("T", "agent1")).toBe(2);
    expect(H.created.map((r) => r.tenantToolId)).toEqual(["tt_list", "tt_order"]);
    expect(H.created.every((r) => r.tenantId === "T" && r.aiAgentId === "agent1" && r.isAllowed === true)).toBe(true);
  });
  it("POST /api/ai-agents grants them when the caller names no tools; the builder uses the same function", () => {
    const route = readFileSync(join(__dirname, "../routes/ai-agents.ts"), "utf8");
    expect(route).toContain("if (!Array.isArray(toolIds)) {\n      const n = await grantConnectedSafeTools(req.tenantId! as string, agent.id);");
    const builder = readFileSync(join(__dirname, "../services/agent-builder.service.ts"), "utf8");
    expect(builder).toContain("const granted = await grantConnectedSafeTools(tenantId, agentId);");
  });
});
