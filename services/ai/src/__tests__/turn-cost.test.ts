/**
 * A bot turn's cost, judged honestly (2026-10-25): the "is the trench coat in
 * M?" turn read 64k nominal input tokens and cost $0.008, because rounds 2 and
 * 3 re-sent a 95%-cached prompt. Pinned:
 *   (a) uncached input = input - cached, summed per turn, on the ai.bot_turn
 *       audit, with one structured alert above the budget (30k by default);
 *   (b) a size question whose search finds ONE variable product gets that
 *       product's variations in the same tool result: one round fewer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const H = vi.hoisted(() => ({ reads: [] as any[], fail: false }));
vi.mock("@chatcenter/shared", () => ({ prisma: {}, normalizeWebchatConfig: vi.fn(), buildWooProductCard: vi.fn(), summarizeWooCards: vi.fn(), WOO_MESSAGE_TYPES: {}, MAX_CAROUSEL_ITEMS: 10 }));
vi.mock("../services/connectors/integration-framework", () => ({
  executeAdapterTool: async (a: any) => {
    H.reads.push(a);
    if (H.fail) return { ok: false, reason: "down" };
    return { ok: true, result: [{ id: 368, attributes: [{ name: "Size", option: "M" }], stock_status: "instock", price: "799", description: "long" }] };
  },
}));
vi.mock("../services/website-widget.service", () => ({ connectedWooStore: vi.fn() }));
vi.mock("../services/widget-promotions.service", () => ({ listActivePromotions: vi.fn() }));
vi.mock("../services/discovery-integration.service", () => ({ resolveWooCurrency: vi.fn() }));

import { uncachedInputOf, alertIfOverBudget } from "../services/turn-usage.service";
import { singleProductVariations } from "../services/woo-chat-turn.service";

const compact = (raw: string) => {
  const p = JSON.parse(raw);
  return JSON.stringify(p.result.map((v: any) => ({ id: v.id, stock: v.stock_status })));
};
const search = (products: any[]) => JSON.stringify({ ok: true, result: products });

beforeEach(() => { H.reads = []; H.fail = false; });

describe("★ (a) uncached input", () => {
  it("input minus cached, never negative, tolerant of missing fields", () => {
    expect(uncachedInputOf({ input_tokens: 21310, cached_tokens: 19968 })).toBe(1342);
    expect(uncachedInputOf({ input_tokens: 100, cached_tokens: 200 })).toBe(0);
    expect(uncachedInputOf({ input_tokens: 500 })).toBe(500);
    expect(uncachedInputOf(null)).toBe(0);
  });

  it("the proof turn's three rounds sum to about 22k: under the budget, no alert", () => {
    const rounds = [{ input_tokens: 20903, cached_tokens: 0 }, { input_tokens: 21310, cached_tokens: 19968 }, { input_tokens: 21516, cached_tokens: 21120 }];
    const total = rounds.reduce((n, r) => n + uncachedInputOf(r), 0);
    expect(total).toBe(22641);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(alertIfOverBudget({ tenantId: "T", conversationId: "c", aiAgentId: "e", uncachedInputTokens: total, totalTokens: 64373 })).toBe(false);
    expect(alertIfOverBudget({ tenantId: "T", conversationId: "c", aiAgentId: "e", uncachedInputTokens: 30001, totalTokens: 64373 })).toBe(true);
    expect(JSON.parse(warn.mock.calls[0][0] as string)).toMatchObject({ tag: "ai.turn.uncached_over_budget", uncachedInputTokens: 30001, limit: 30000 });
    warn.mockRestore();
  });

  it("every model round in the bot turn counts, and the audit keeps it", () => {
    const src = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf-8");
    const adds = (src.match(/totalTokens \+= \w+\.usage\.total_tokens \|\| 0;/g) ?? []).length;
    const counted = (src.match(/totalTokens \+= (\w+)\.usage\.total_tokens \|\| 0; uncachedInputTokens \+= uncachedInputOf\(\1\.usage\);/g) ?? []).length;
    expect(adds).toBeGreaterThan(0);
    expect(counted).toBe(adds);
    const audit = src.slice(src.indexOf('action: "ai.bot_turn"'), src.indexOf("behaviorState: {", src.indexOf('action: "ai.bot_turn"')));
    expect(audit).toMatch(/uncachedInputTokens,/);
    expect(audit).toMatch(/uncachedOverBudget: alertIfOverBudget\(/);
  });
});

describe("★ (b) one product found: its variations ride along", () => {
  it("one variable product: read once, compacted", async () => {
    const out = await singleProductVariations("T", search([{ id: 364, type: "variable" }]), compact);
    expect(out).toBe('[{"id":368,"stock":"instock"}]');
    expect(H.reads).toEqual([expect.objectContaining({ toolFunctionName: "woocommerce.list_product_variations", args: { product_id: "364", per_page: 50 }, accessScope: "internal" })]);
  });

  it("several products, a simple product, unparseable content or a failed read: null, the model reads them itself", async () => {
    expect(await singleProductVariations("T", search([{ id: 1, type: "variable" }, { id: 2, type: "variable" }]), compact)).toBeNull();
    expect(await singleProductVariations("T", search([{ id: 1, type: "simple" }]), compact)).toBeNull();
    expect(await singleProductVariations("T", "not json", compact)).toBeNull();
    H.fail = true;
    expect(await singleProductVariations("T", search([{ id: 1, type: "variable" }]), compact)).toBeNull();
  });

  it("only on a lookup turn, only for one candidate, attached to the search's own tool result", () => {
    const src = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf-8");
    expect(src).toMatch(/if \(discoveryLookup && toolName === "woocommerce\.list_products" && envlp\.candidates\.length === 1\)/);
    expect(src).toContain("VARIATIONS of PRODUCT_1 (live, already read; do not call list_product_variations for it)");
  });
});
