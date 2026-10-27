/** urban-e27 (dev 2026-10-27): P2's read, the side calls' cap, and the gate's last rules. */
import { describe, it, expect, vi } from "vitest";
const A = vi.hoisted(() => ({ where: null as any, rows: [] as any[] }));
vi.mock("@chatcenter/shared", async (orig) => ({
  ...(await orig() as any),
  prisma: { auditLog: { findMany: async (q: any) => { A.where = q.where; return A.rows; } } },
}));
import { lastSearchArgs } from "../services/woo-chat-turn.service";
import { capped, judgementCapMs } from "../services/judgement-cap";
import { finalTextIssues, normalizePunctuation, checkReplyStyle, fixInCode, type FinalGateContext } from "../services/reply-style-check.service";

describe("P2 reads the last search from the turn audit's target", () => {
  it("by targetType/targetId (metadata has no conversationId), newest call first", async () => {
    A.rows = [{ metadata: { toolCalls: [{ tool: "woocommerce.list_products", args: { query: "coat", audience: "men" } }] } }];
    expect(await lastSearchArgs("T", "c1")).toEqual({ query: "coat", audience: "men" });
    expect(A.where).toEqual({ tenantId: "T", action: "ai.bot_turn", targetType: "conversation", targetId: "c1" });
  });
  it("none: null", async () => {
    A.rows = [{ metadata: {} }];
    expect(await lastSearchArgs("T", "c1")).toBeNull();
  });
});

describe("the side calls' cap", () => {
  it("6s on dev by default; set or off", () => {
    expect(judgementCapMs({ NODE_ENV: "development" } as any)).toBe(6000);
    expect(judgementCapMs({ NODE_ENV: "production" } as any)).toBeNull();
    expect(judgementCapMs({ NODE_ENV: "production", AI_JUDGEMENT_CAP_MS: "5000" } as any)).toBe(5000);
    expect(judgementCapMs({ NODE_ENV: "development", AI_JUDGEMENT_CAP_MS: "off" } as any)).toBeNull();
  });
  it("past the cap the fail-soft value; within it the answer; a late error is swallowed", async () => {
    const slow = new Promise<string[]>((r) => setTimeout(() => r(["late"]), 50));
    expect(await capped(slow, [], "x", "c1", 10)).toEqual([]);
    expect(await capped(Promise.resolve(["fast"]), [], "x", "c1", 50)).toEqual(["fast"]);
    const failsLate = new Promise<string[]>((_r, j) => setTimeout(() => j(new Error("late")), 30));
    expect(await capped(failsLate, ["soft"], "x", "c1", 5)).toEqual(["soft"]);
    await new Promise((r) => setTimeout(r, 40));
  });
  it("wired on all three, with their own fail-soft values", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = (f: string) => readFileSync(join(__dirname, "../services", f), "utf8");
    expect(src("ai-bot.service.ts")).toContain(`}), [], "knowledge-resolve", opts.conversationId);`);
    expect(src("plan-context.service.ts")).toContain(`}), EMPTY_WIZARD_FACTS, "wizard binding", input.conversationId);`);
    expect(src("discovery-integration.service.ts")).toContain(`}).catch(() => []), [], "discovery extraction", opts.conversationId);`);
  });
});

const gate = (o: Partial<FinalGateContext> = {}): FinalGateContext => ({
  locale: "he", isFirstReply: true, incomingMessage: "אני מחפש מעיל", productFactsAvailable: true, shopFloor: false,
  toolsOffered: [], customerClosing: false, cardsShown: true, productTitles: [], ...o,
});

describe("the gate's last rules", () => {
  it("over new cards, a question and nothing else", () => {
    expect(finalTextIssues("היי! איזו מידה מתאימה לך?", gate())).toContain("question_only");
    expect(finalTextIssues("יש טרנץ' קל ומעיל צמר ארוך. איזו מידה מתאימה לך?", gate())).not.toContain("question_only");
    expect(finalTextIssues("הנה שוב:", gate())).toEqual([]);
  });
  it("a masculine product noun with a feminine adjective", () => {
    expect(finalTextIssues("מעיל תערובת צמר ארוך וחמימה.", gate())).toContain("agreement");
    expect(finalTextIssues("מעיל תערובת צמר ארוך וחם.", gate())).not.toContain("agreement");
  });
  it("a blank line between two lines", () => {
    expect(normalizePunctuation("שני רעיונות בתקציב.\n\nעדיף פריט לבוש או אביזר?")).toBe("שני רעיונות בתקציב.\nעדיף פריט לבוש או אביזר?");
  });
  it("\"להציג את המעיל הזה בכרטיס מוצר\" narrates the card", () => {
    const d = "יש מעיל צמר ארוך וחם. להציג את המעיל הזה בכרטיס מוצר או לראות חלופה אחרת?";
    const c: any = { ...gate(), shopFloor: true };
    const v = checkReplyStyle(d, c);
    expect(v.map((x) => x.kind)).toContain("card_narration");
    expect(fixInCode(d, v)).toBe("יש מעיל צמר ארוך וחם.");
  });
});
