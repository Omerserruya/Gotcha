/**
 * GET /api/ai-assist/:conversationId/ai-activity - the AI's recent steps,
 * through the real router, without args or results; and the labelKey map
 * covers every tool name the bot has actually used.
 */
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

const H = vi.hoisted(() => ({ lastSelect: null as any }));
const at = (s: number) => new Date(Date.UTC(2026, 9, 6, 10, 0, s));

vi.mock("@chatcenter/shared", () => ({
  requireInternalKey: (_q: any, _s: any, n: any) => n(),
  requireEntitlement: () => (_q: any, _s: any, n: any) => n(),
  authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "agent1", role: "AGENT" }; n(); },
  resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "T"; n(); },
  requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
  requireRole: () => (_q: any, _s: any, n: any) => n(),
  resolveConversationLocale: async () => "en",
  resolveEffectiveLocale: async () => "en",
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  getRedis: () => ({}),
  isEntitled: async () => true,
  publishEvent: async () => undefined,
  normalizePhone: (s: string) => s,
  prisma: {
    conversation: { findFirst: async (a: any) => (a.where.id === "c1" && a.where.tenantId === "T" ? { id: "c1" } : null) },
    toolExecutionRequest: {
      findMany: async (a: any) => {
        if (a.where.tenantId !== "T" || a.where.conversationId !== "c1") return [];
        H.lastSelect = a.select;
        return [
          { id: "e2", tool: "shopify.search_products", status: "running", error: null, proposedAt: at(5), startedAt: at(5), completedAt: null },
          { id: "e1", tool: "integration_order_lookup", status: "completed", error: null, proposedAt: at(1), startedAt: at(1), completedAt: at(3) },
          { id: "e0", tool: "shopify.process_refund", status: "denied", error: "agent declined", proposedAt: at(0), startedAt: null, completedAt: null },
        ].slice(0, a.take);
      },
    },
  },
}));
vi.mock("../services/ai-assist.service", () => ({ getSuggestions: vi.fn(), getEffectiveCopilotConfig: async () => null }));
vi.mock("../services/agent-config-generator", () => ({ generateAllAgentConfigs: vi.fn(), generateAgentConfig: vi.fn() }));
vi.mock("../services/conversation-intelligence.service", () => ({ analyzeConversation: vi.fn(), getConversationIntelligence: vi.fn(), getConversationReplay: vi.fn() }));
vi.mock("../services/tool-execution.service", () => ({ getToolsForTenant: vi.fn(), executeTool: vi.fn(), getToolExecutions: vi.fn() }));
vi.mock("../services/agent-performance.service", () => ({ scoreAgent: vi.fn(), getAgentScore: vi.fn() }));
vi.mock("../services/followup-generator.service", () => ({ generateFollowup: vi.fn() }));
vi.mock("../services/customer-state.service", () => ({ buildCustomerState: vi.fn() }));
vi.mock("../services/ai.service", () => ({ generateResponse: vi.fn(), getDefaultModel: () => "gpt-4o-mini" }));

import aiAssistRoutes from "../routes/ai-assist";
import { labelKeyFor } from "../services/ai-activity.service";

const app = express();
app.use("/api/ai-assist", aiAssistRoutes);

describe("GET /:conversationId/ai-activity", () => {
  it("★ newest first, labelled, timed, and never selects args or result", async () => {
    const r = await request(app).get("/api/ai-assist/c1/ai-activity");
    expect(r.status).toBe(200);
    expect(r.body.data.map((s: any) => [s.id, s.labelKey, s.status])).toEqual([
      ["e2", "checking_products", "running"],
      ["e1", "looking_up_order", "completed"],
      ["e0", "processing_refund", "denied"],
    ]);
    expect(r.body.data[1]).toMatchObject({ durationMs: 2000, error: null });
    expect(r.body.data[2].error).toBe("agent declined");
    expect(H.lastSelect).not.toHaveProperty("args");
    expect(H.lastSelect).not.toHaveProperty("result");
  });

  it("limit, and 404 for another tenant's conversation", async () => {
    expect((await request(app).get("/api/ai-assist/c1/ai-activity?limit=1")).body.data).toHaveLength(1);
    expect((await request(app).get("/api/ai-assist/other/ai-activity")).status).toBe(404);
  });
});

describe("labelKeyFor", () => {
  it("★ every tool the bot has used on dev maps to a real label, not the fallback", () => {
    // `select distinct tool from tool_execution_requests` on dev, 2026-10-06.
    const used = "escalate_to_human integration_cancel_order integration_order_lookup link_customer_identifier shopify.add_order_note shopify.cancel_order shopify.check_delivery_eta shopify.create_note shopify.create_return shopify.edit_order shopify.exchange_order_item shopify.find_latest_order shopify.get_fulfillment_status shopify.get_order shopify.get_order_items shopify.get_returns shopify.get_shipment_status shopify.get_tracking_url shopify.order_lookup shopify.process_refund shopify.reconcile_order_items shopify.resend_confirmation shopify.search_products shopify.send_invoice shopify.track_shipment shopify.update_my_profile shopify.update_order_fulfillment shopify.update_order_shipping_address shopify.variant_information".split(" ");
    const unmapped = used.filter((t) => labelKeyFor(t) === "working");
    expect(unmapped).toEqual([]);
  });

  it("specific before generic: a refund is not 'looking up an order'", () => {
    expect(labelKeyFor("shopify.process_refund")).toBe("processing_refund");
    expect(labelKeyFor("integration_cancel_order")).toBe("cancelling_order");
    expect(labelKeyFor("shopify.get_returns")).toBe("handling_return");
    expect(labelKeyFor("shopify.get_fulfillment_status")).toBe("checking_delivery");
    expect(labelKeyFor("woocommerce.update_order_status")).toBe("updating_order");
    expect(labelKeyFor("something_new")).toBe("working");
  });
});
