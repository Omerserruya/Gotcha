/**
 * ★ A WhatsApp conversation that continues a website chat gives the bot that
 * chat as context (oldest first, customer and business lines, no system
 * events), so the customer is not asked to repeat themselves.
 */
import { describe, it, expect, vi } from "vitest";

const H = vi.hoisted(() => ({ asked: [] as any[] }));
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    prisma: {
      message: {
        findMany: async (a: any) => {
          H.asked.push(a.where);
          // Newest first, as asked.
          return [
            { direction: "OUTBOUND", body: "Sure, the oak one is in stock." },
            { direction: "INBOUND", body: "   " },
            { direction: "INBOUND", body: "Do you have the oak lamp?" },
          ];
        },
      },
    },
  };
});

import { websiteHandoffContext } from "../services/website-handoff-context.service";

const ev = { messageType: "system", metadata: { systemEvent: "continued_from_website", fromConversationId: "web1" } };

describe("★ the website chat as context", () => {
  it("oldest first, customer and business, the tenant's own conversation, no system events", async () => {
    const block = await websiteHandoffContext("T", [{ messageType: "text" }, ev]);
    expect(block).toContain("Customer: Do you have the oak lamp?\nBusiness: Sure, the oak one is in stock.");
    expect(block).toMatch(/Do not ask for anything they already told you there/);
    expect(H.asked.at(-1)).toEqual({ tenantId: "T", conversationId: "web1", messageType: { not: "system" } });
  });

  it("no such event: no context", async () => {
    expect(await websiteHandoffContext("T", [{ messageType: "text" }, { messageType: "system", metadata: { systemEvent: "conversation_merged", fromConversationId: "other" } }])).toBeNull();
  });
});
