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
    // e11 Z8: the newer of the last search and the last product named.
    const at = src.indexOf("const mention = pickLastProduct(lastProductMention(messages as any[]), await lastProductSearch(opts.tenantId, opts.conversationId));");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(src.indexOf('markStage("prompt_ready");'));
    expect(src).toContain("if (wooTurn && (askedColours(opts.incomingMessage).length > 0 || asksSize(opts.incomingMessage)) && !namesProduct(opts.incomingMessage)) {");
  });
});

describe("★ e9 W2: a product named only in our text", () => {
  it("the latest mention wins: a title in our words after a card", async () => {
    const { lastProductMention } = await import("../services/woo-chat-turn.service");
    expect(lastProductMention([card("1", "Ribbed Beanie"), { direction: "OUTBOUND", messageType: "text", body: "יש גם את Canvas Tote בשחור" }]))
      .toEqual({ title: "Canvas Tote" });
    expect(lastProductMention([{ direction: "OUTBOUND", messageType: "text", body: "יש את Canvas Tote" }, card("2", "Wool Scarf")]))
      .toEqual({ productId: "2", title: "Wool Scarf" });
  });
  it("Hebrew text with no store title: nothing", async () => {
    const { lastProductMention } = await import("../services/woo-chat-turn.service");
    expect(lastProductMention([{ direction: "OUTBOUND", messageType: "text", body: "יש לנו תיקים יפים" }])).toBeNull();
  });
});

const botSrc = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");

describe("★ L01c Y1: a message naming another product is not about the last one", () => {
  it.each(["הכותנה נשמעת טוב, יש בנייבי?", "צעיף באפור יש?", "ויש תיק בד?", "is the Canvas Tote in black?"])("%s names a product", async (t) => {
    const { namesProduct } = await import("../services/woo-chat-turn.service");
    expect(namesProduct(t)).toBe(true);
  });
  it.each(["בשחור?", "ב-L?", "יש באפור?", "ומה עם מידה M?"])("%s does not", async (t) => {
    const { namesProduct } = await import("../services/woo-chat-turn.service");
    expect(namesProduct(t)).toBe(false);
  });
  it("the last product's options are attached only then", () => {
    expect(botSrc).toContain("&& !namesProduct(opts.incomingMessage)) {");
  });
});

describe("★ L01c Y2: Hebrew shop words reach the English titles", () => {
  it("the glossary maps תיק בד to a canvas tote and rides in both search directives", async () => {
    const { HEBREW_PRODUCT_GLOSSARY } = await import("../services/woo-chat-turn.service");
    expect(HEBREW_PRODUCT_GLOSSARY).toContain("תיק בד = canvas tote");
    expect(botSrc).toContain("(${HEBREW_PRODUCT_GLOSSARY})");
    const intent = readFileSync(join(__dirname, "../services/product-intent.service.ts"), "utf8");
    expect(intent).toContain("${HEBREW_PRODUCT_GLOSSARY}");
  });
});
