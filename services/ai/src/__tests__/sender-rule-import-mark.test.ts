/**
 * The sender rule reads the history import's verdict (2026-11-22): a contact the import marked personal
 * comes in personal from their first new message, unless a person ever marked the sender, whose newest
 * mark decides both ways. Email stays out, as before.
 */
import { describe, it, expect, vi } from "vitest";
vi.mock("../services/ai.service", () => ({ generateResponse: vi.fn(), getDefaultModel: () => "m", platformPaidScope: { run: (_: any, f: any) => f() } }));
import { senderMarkedPersonal } from "../services/conversation-relevance.service";

const db = (hand: any, imported: any) => {
  const wheres: any[] = [];
  return {
    wheres,
    conversation: {
      findFirst: async (a: any) => { wheres.push(a.where); return a.where.relevanceSource === "override" ? hand : a.where.relevanceSource === "import" ? imported : null; },
    },
  };
};
const input = (o: any = {}) => ({ channel: "WHATSAPP", customerExternalId: "+972501111111", conversationId: "new1", firstDirection: "INBOUND", messages: [], ...o }) as any;

describe("the sender rule and the import's mark", () => {
  it("★ no person's mark, the import said personal: personal", async () => {
    const d = db(null, { id: "imp-conv" });
    expect(await senderMarkedPersonal("T", input(), d)).toBe(true);
    expect(d.wheres[1]).toMatchObject({ tenantId: "T", channel: "WHATSAPP", origin: "HISTORICAL_IMPORT", relevanceSource: "import", relevanceCategory: "personal", customerExternalId: { in: ["972501111111", "+972501111111"] } });
  });

  it("★ a person marked the sender business: business, the import's personal does not count", async () => {
    expect(await senderMarkedPersonal("T", input(), db({ relevanceCategory: "business" }, { id: "imp-conv" }))).toBe(false);
  });

  it("a person marked personal: personal, without asking the import", async () => {
    const d = db({ relevanceCategory: "personal" }, null);
    expect(await senderMarkedPersonal("T", input(), d)).toBe(true);
    expect(d.wheres).toHaveLength(1);
  });

  it("neither: not personal; email never", async () => {
    expect(await senderMarkedPersonal("T", input(), db(null, null))).toBe(false);
    expect(await senderMarkedPersonal("T", input({ channel: "GMAIL", customerExternalId: "a@b.co" }), db(null, { id: "x" }))).toBe(false);
  });
});
