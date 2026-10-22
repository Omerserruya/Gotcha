/**
 * The readiness report judges an employee by the tools that can RUN
 * (2026-10-13): a grant on a disconnected store, or on a tool the workspace
 * turned off, does nothing for a customer and must not score as coverage.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ perms: [] as any[], prompt: "", lastWhere: null as any, lastOrder: null as any }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    readDurableSetting: async () => null,
    writeDurableSetting: async () => {},
    prisma: {
      knowledgeBase: { findMany: async () => [] },
      aIAgent: { findFirst: async () => ({ id: "a1", name: "Noa", role: "customer_support", goal: "help", successCriteria: "", identity: {} }) },
      businessProfile: { findUnique: async () => ({ organizationName: "Shop", industry: "retail", businessDescription: "" }) },
      aIAgentKnowledge: { findMany: async () => [] },
      knowledgeDocument: { findMany: async () => [] },
      agentToolPermission: {
        // Interprets the filter the service sends, so the test fails if the
        // service stops asking for runnable tools.
        findMany: async (a: any) => {
          H.lastWhere = a.where; H.lastOrder = a.orderBy;
          const w = a.where;
          let rows = H.perms.filter((p) =>
            p.tenantId === w.tenantId && p.aiAgentId === w.aiAgentId && p.isAllowed === w.isAllowed &&
            (w.tenantTool?.isEnabled === undefined || p.tenantTool.isEnabled === w.tenantTool.isEnabled) &&
            (w.tenantTool?.tenantIntegration?.status === undefined || p.tenantTool.tenantIntegration.status === w.tenantTool.tenantIntegration.status));
          if (a.orderBy?.[0]?.tenantTool?.catalogTool?.name === "asc") rows = [...rows].sort((x, y) => x.tenantTool.catalogTool.name.localeCompare(y.tenantTool.catalogTool.name));
          return rows.slice(0, a.take ?? rows.length);
        },
      },
    },
  };
});
vi.mock("../services/ai.service", () => ({
  // Two calls since B6: the question set (once), then the judge, whose prompt
  // is the one that lists the tools.
  generateResponse: vi.fn(async (o: any) => {
    if (o.metadata?.type === "agent_readiness_questions") return { content: JSON.stringify({ questions: ["Where is my order?"] }) };
    H.prompt = o.messages[1].content;
    return { content: JSON.stringify({ judgements: [], recommendations: [] }) };
  }),
}));

import { generateReadinessReport } from "../services/agent-readiness.service";

const perm = (name: string, status: string, isEnabled = true, isAllowed = true) => ({
  tenantId: "T", aiAgentId: "a1", isAllowed,
  tenantTool: { isEnabled, catalogTool: { name, description: "" }, tenantIntegration: { status, integration: { name: status === "CONNECTED" ? "WooCommerce" : "Shopify" } } },
});

beforeEach(() => { H.prompt = ""; });

describe("readiness counts only tools that can run", () => {
  it("★ a disconnected store's grants and a disabled tool are not offered to the auditor", async () => {
    H.perms = [
      perm("Get order", "CONNECTED"),
      perm("Cancel order", "DISCONNECTED"),
      perm("Create return", "DISCONNECTED"),
      perm("Create coupon", "CONNECTED", false),
      perm("Refund", "CONNECTED", true, false),
    ];
    await generateReadinessReport("T", "a1", "en");
    expect(H.prompt).toContain('tool "Get order" (WooCommerce)');
    for (const dead of ["Cancel order", "Create return", "Create coupon", "Refund"]) expect(H.prompt).not.toContain(dead);
  });

  it("★ the same tools every run: ordered by name before the cap", async () => {
    H.perms = Array.from({ length: 70 }, (_, i) => perm(`Tool ${String(69 - i).padStart(2, "0")}`, "CONNECTED"));
    await generateReadinessReport("T", "a1", "en");
    expect(H.prompt).toContain('tool "Tool 00" (WooCommerce)');
    expect(H.prompt).toContain('tool "Tool 59" (WooCommerce)');
    expect(H.prompt).not.toContain('tool "Tool 60" (WooCommerce)');
  });

  it("no runnable tool: the auditor is told so", async () => {
    H.perms = [perm("Cancel order", "DISCONNECTED")];
    await generateReadinessReport("T", "a1", "en");
    expect(H.prompt).toContain("(no action tools granted)");
  });
});
