import { describe, it, expect, vi } from "vitest";

vi.mock("@chatcenter/shared", () => ({
  // Durable tenant settings (business hours, auto-greeting, SLA). Exhaustive
  // mocks of this barrel must supply them or the read path throws instead of
  // returning "not configured". Default: nothing configured.
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  // Version pins now live in shared modules, so exhaustive mocks of this
  // barrel must supply them. Returning the real defaults keeps any URL the
  // code builds meaningful instead of "undefined/...".
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  findSiblingContacts: vi.fn().mockResolvedValue([]),
  prisma: {
    contact: {
      findFirst: vi.fn().mockResolvedValue({
        id: "c1",
        tenantId: "t1",
        channel: "WHATSAPP",
        externalId: "+123",
        displayName: "Ada",
        email: "ada@example.com",
        phone: "+123",
        tags: ["vip"],
        lastInteractionAt: new Date("2026-04-10T00:00:00Z"),
      }),
    },
    conversation: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "conv1",
          status: "OPEN",
          updatedAt: new Date("2026-04-12T00:00:00Z"),
          aiSummary: "Customer asked about refund",
          intelligence: null,
        },
        {
          id: "conv2",
          status: "CLOSED",
          updatedAt: new Date("2026-04-01T00:00:00Z"),
          aiSummary: null,
          intelligence: { summary: "Resolved billing issue" },
        },
      ]),
    },
    auditLog: {
      // Customer-state now queries with targetType="contact" + targetId,
      // so the mock already returns only matching rows.
      findMany: vi.fn().mockResolvedValue([
        {
          action: "action.tag_contact",
          createdAt: new Date("2026-04-11T00:00:00Z"),
          metadata: { reason: "churn", riskLevel: "low" },
        },
      ]),
    },
  },
}));

import { buildCustomerState } from "../services/customer-state.service";

describe("buildCustomerState", () => {
  it("returns null when contact is missing", async () => {
    const { prisma } = await import("@chatcenter/shared");
    (prisma.contact.findFirst as any).mockResolvedValueOnce(null);
    const state = await buildCustomerState("t1", "missing");
    expect(state).toBeNull();
  });

  it("aggregates summaries, open convos, and filtered decisions", async () => {
    const state = await buildCustomerState("t1", "c1");
    expect(state).not.toBeNull();
    expect(state!.contactId).toBe("c1");
    expect(state!.openConversationIds).toEqual(["conv1"]);
    expect(state!.recentSummaries).toHaveLength(2);
    expect(state!.recentSummaries[0].summary).toBe("Customer asked about refund");
    // audit filter: only decisions whose metadata.params.contactId matches
    expect(state!.recentDecisions).toHaveLength(1);
    expect(state!.recentDecisions[0].action).toBe("action.tag_contact");
  });
});
