/**
 * A colour or size asked about the product just shown gets its live options
 * (2026-10-25, eval L01: "בשחור?" right after the beanie got "אין אישור לצבע").
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@chatcenter/shared", async (importOriginal) => ({ ...(await importOriginal<any>()), prisma: {} }));

import { lastShownProduct, asksSize } from "../services/woo-chat-turn.service";

const card = (productId: string, title: string) => ({ direction: "OUTBOUND", messageType: "woo_product", metadata: { commerce: { products: [{ productId, title }] } } });

describe("★ the product shown most recently", () => {
  it("the latest card's store id and title", () => {
    expect(lastShownProduct([card("1", "Ribbed Beanie"), { direction: "INBOUND", messageType: "text" }, card("2", "Wool Scarf"), { direction: "INBOUND" }]))
      .toEqual({ productId: "2", title: "Wool Scarf" });
  });
  it("none shown: null", () => {
    expect(lastShownProduct([{ direction: "INBOUND", messageType: "text" }])).toBeNull();
  });
});

describe("★ a size question", () => {
  it.each(["S", "יש ב-M?", "איזו מידה?", "what size?"])("%s", (t) => expect(asksSize(t)).toBe(true));
  it.each(["בשחור?", "כמה זה עולה?"])("%s is not", (t) => expect(asksSize(t)).toBe(false));
});

describe("★ wired: one live read, on a colour or size turn, before the state note", () => {
  const src = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
  it("the options of the last shown product ride along", () => {
    const at = src.indexOf("const last = lastShownProduct(messages as any[]);");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(src.indexOf('markStage("prompt_ready");'));
    expect(src).toContain("if (wooTurn && (askedColours(opts.incomingMessage).length > 0 || asksSize(opts.incomingMessage))) {");
  });
});
