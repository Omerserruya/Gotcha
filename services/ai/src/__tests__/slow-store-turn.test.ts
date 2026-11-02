/**
 * A slow store must not cost the customer their answer (Tehila, 2026-11-02:
 * 12-24s per WooCommerce call, an 81s turn, a product question handed to a
 * person).
 *   - a store request that does not answer is cut at WOO_REQUEST_TIMEOUT_MS
 *   - the turn's tool budget and the forced-answer note
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const R = vi.hoisted(() => ({ delay: null as string | null }));
vi.mock("@chatcenter/shared", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  assertPublicUrl: vi.fn(async () => undefined),
  getRedis: () => ({ get: async () => R.delay }),
}));

import Woo, { wooRequestTimeoutMs, debugStoreDelay } from "../services/connectors/woocommerce.adapter";
import { toolBudgetMs, TOOL_BUDGET_NOTE } from "../services/ai-bot.service";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; delete process.env.WOO_REQUEST_TIMEOUT_MS; });

describe("a store that does not answer", () => {
  it("is cut at the request timeout with a clear error, not left hanging", async () => {
    process.env.WOO_REQUEST_TIMEOUT_MS = "80";
    // A fetch that only ends when its signal aborts, like a store that never answers.
    globalThis.fetch = ((_u: any, init: any) => new Promise((_res, rej) => {
      init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
    })) as any;
    const t0 = Date.now();
    const out: any = await Woo.execute({ toolName: "list_products", args: { query: "מטפחות" }, credentials: { consumerKey: "ck", consumerSecret: "cs" }, config: { storeUrl: "https://shop.example.com" } } as any)
      .catch((e: any) => ({ thrown: String(e?.message) }));
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(JSON.stringify(out)).toMatch(/woocommerce_timeout/);
  });

  it("defaults: 20s per store request, 40s of tools per turn; both tunable", () => {
    expect(wooRequestTimeoutMs({} as any)).toBe(20_000);
    expect(wooRequestTimeoutMs({ WOO_REQUEST_TIMEOUT_MS: "8000" } as any)).toBe(8000);
    expect(toolBudgetMs({} as any)).toBe(40_000);
    expect(toolBudgetMs({ AI_TOOL_BUDGET_MS: "junk" } as any)).toBe(40_000);
  });

  it("past the budget the model is told to answer from what it found, without promising a check", () => {
    expect(TOOL_BUDGET_NOTE).toMatch(/Answer the customer now from what you already found/);
    expect(TOOL_BUDGET_NOTE).toMatch(/Do not call any tool/);
  });
});

describe("the dev-only slow-store switch", () => {
  it("never applies in production, whatever Redis says", async () => {
    R.delay = "5000";
    expect(await debugStoreDelay({ NODE_ENV: "production" } as any)).toBe(0);
  });
  it("on dev it waits the set time; unset is no wait", async () => {
    R.delay = "30";
    expect(await debugStoreDelay({ NODE_ENV: "development" } as any)).toBe(30);
    R.delay = null;
    expect(await debugStoreDelay({ NODE_ENV: "development" } as any)).toBe(0);
  });
});
