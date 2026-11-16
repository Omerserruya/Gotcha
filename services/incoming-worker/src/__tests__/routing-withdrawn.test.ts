/**
 * Turning the routing automation off stops the AI on conversations it already
 * owns (prod Alea Design 2026-11-16: routed to the AI 09:55, flow off 10:09,
 * the AI still answered 10:17).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@chatcenter/shared", () => ({ prisma: {}, publishEvent: vi.fn(async () => undefined) }));

import { routingWithdrawn, releaseWithdrawnRouting } from "../services/routing-withdrawn.service";

const AGENT = "noa";
const conv = (over: Record<string, unknown> = {}) => ({
  id: "cmwj38iz9008175qb1xr4zj8e", tenantId: "alea", status: "OPEN", assignedAiAgentId: AGENT, assignedAgentId: null, isHandedOver: false, ...over,
});

function fakeDb(opts: { step?: any; updated?: number } = {}) {
  const calls: any = { findFirst: [], updateMany: [], audit: [] };
  return {
    calls,
    automationRunStep: { findFirst: async (a: any) => { calls.findFirst.push(a); return opts.step ?? null; } },
    conversation: { updateMany: async (a: any) => { calls.updateMany.push(a); return { count: opts.updated ?? 1 }; } },
    auditLog: { create: async (a: any) => { calls.audit.push(a); return {}; } },
  };
}
const routeStep = (isActive: boolean, output: any = { action: "route", routeType: "agent", targetId: AGENT }) => ({
  output, run: { flowId: "setup-flow", flow: { isActive, name: "Who answers new conversations" } },
});

describe("routingWithdrawn", () => {
  it("the Alea sequence: routed to the AI, the flow turned off -> withdrawn", async () => {
    const db = fakeDb({ step: routeStep(false) });
    expect(await routingWithdrawn(conv(), db)).toEqual({ flowId: "setup-flow", flowName: "Who answers new conversations", aiAgentId: AGENT });
    // It reads only route steps of THIS conversation in THIS tenant, newest first.
    expect(db.calls.findFirst[0].where).toMatchObject({ tenantId: "alea", nodeType: { in: ["route_target", "default_fallback"] }, run: { conversationId: conv().id, tenantId: "alea" } });
    expect(db.calls.findFirst[0].orderBy).toEqual({ at: "desc" });
  });
  it("the flow still active -> the AI keeps it", async () => {
    expect(await routingWithdrawn(conv(), fakeDb({ step: routeStep(true) }))).toBeNull();
  });
  it("a person owns it, or it was handed over, or it is closed -> not this check's business", async () => {
    const db = fakeDb({ step: routeStep(false) });
    expect(await routingWithdrawn(conv({ assignedAgentId: "u1" }), db)).toBeNull();
    expect(await routingWithdrawn(conv({ isHandedOver: true }), db)).toBeNull();
    expect(await routingWithdrawn(conv({ status: "CLOSED" }), db)).toBeNull();
    expect(await routingWithdrawn(conv({ assignedAiAgentId: null }), db)).toBeNull();
    expect(db.calls.findFirst).toHaveLength(0);
  });
  it("assigned to the AI by another path later (another employee) -> never overridden", async () => {
    expect(await routingWithdrawn(conv({ assignedAiAgentId: "dana" }), fakeDb({ step: routeStep(false) }))).toBeNull();
  });
  it("the automation's last route sent it to a person or a sub-flow -> not an AI routing", async () => {
    expect(await routingWithdrawn(conv(), fakeDb({ step: routeStep(false, { routeType: "human", targetId: null }) }))).toBeNull();
  });
  it("never routed by an automation (department picker) -> the AI keeps it", async () => {
    expect(await routingWithdrawn(conv(), fakeDb({ step: null }))).toBeNull();
  });
  it("an unreadable run log never withdraws", async () => {
    const db: any = { automationRunStep: { findFirst: async () => { throw new Error("db down"); } } };
    expect(await routingWithdrawn(conv(), db)).toBeNull();
    expect(await routingWithdrawn(conv(), {} as any)).toBeNull();
  });
});

describe("releaseWithdrawnRouting", () => {
  it("open, unassigned, visible, one audit row; only if still held by that AI employee", async () => {
    const db = fakeDb();
    const w = { flowId: "setup-flow", flowName: "Who answers new conversations", aiAgentId: AGENT };
    expect(await releaseWithdrawnRouting("alea", conv().id, w, db)).toBe(true);
    expect(db.calls.updateMany[0]).toEqual({
      where: { id: conv().id, tenantId: "alea", assignedAiAgentId: AGENT, assignedAgentId: null },
      data: { assignedAiAgentId: null, handledBy: null },
    });
    // Status is not touched: it stays OPEN in the inbox.
    expect(db.calls.updateMany[0].data).not.toHaveProperty("status");
    expect(db.calls.audit[0].data).toMatchObject({ tenantId: "alea", action: "ai.routing_withdrawn", targetId: conv().id, metadata: { flowId: "setup-flow", aiAgentId: AGENT } });
  });
  it("someone took it in the meantime -> nothing written", async () => {
    const db = fakeDb({ updated: 0 });
    expect(await releaseWithdrawnRouting("alea", conv().id, { flowId: "f", flowName: null, aiAgentId: AGENT }, db)).toBe(false);
    expect(db.calls.audit).toHaveLength(0);
  });
});

describe("processAIBot honours it before any AI call", () => {
  it("checks right after the person-owns-it guard, and returns before the agent lookup", () => {
    const src = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    const guard = src.indexOf("conversation.isHandedOver || conversation.assignedAgentId) return false;");
    const check = src.indexOf("await routingWithdrawn(conversation");
    const agentLookup = src.indexOf("prisma.aIAgent.findUnique");
    expect(guard).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(guard);
    expect(check).toBeLessThan(agentLookup);
    expect(src.slice(check, check + 400)).toMatch(/releaseWithdrawnRouting[\s\S]*return false;/);
  });
});
