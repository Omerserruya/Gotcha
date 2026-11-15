/**
 * productQueryInEnglish: the Hebrew product word in English for an
 * English-title store (eval A05, dev 2026-11-15: "גרביים" -> "Socks").
 * One micro-model call per tenant and query for ten minutes; only Latin
 * words are used; a refusal or failure is null, never thrown, never cached.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ gen: vi.fn(async (_r: any): Promise<any> => ({ content: "Socks" })) }));
vi.mock("../services/ai.service", () => ({ generateResponse: H.gen, getMicroModel: () => "micro" }));

import { productQueryInEnglish, clearProductQueryCache } from "../services/query-translation.service";

beforeEach(() => { clearProductQueryCache(); H.gen.mockClear(); H.gen.mockImplementation(async () => ({ content: "Socks" })); vi.spyOn(console, "warn").mockImplementation(() => undefined); });

describe("productQueryInEnglish", () => {
  it("translates once, metered as product_query_translation, on the micro model", async () => {
    expect(await productQueryInEnglish("t1", "גרביים")).toBe("Socks");
    const req = H.gen.mock.calls[0][0];
    expect(req).toMatchObject({ tenantId: "t1", model: "micro", metadata: { type: "product_query_translation" } });
    expect(req.signal).toBeDefined();
  });
  it("the same tenant and query within ten minutes: no second call; after: a new one", async () => {
    const t0 = 1_000_000;
    await productQueryInEnglish("t1", "גרביים", t0);
    await productQueryInEnglish("t1", "גרביים", t0 + 9 * 60_000);
    expect(H.gen).toHaveBeenCalledTimes(1);
    await productQueryInEnglish("t1", "גרביים", t0 + 11 * 60_000);
    expect(H.gen).toHaveBeenCalledTimes(2);
    await productQueryInEnglish("t2", "גרביים", t0 + 11 * 60_000);
    expect(H.gen).toHaveBeenCalledTimes(3);
  });
  it("a Latin query, an empty one, or no tenant: no call", async () => {
    expect(await productQueryInEnglish("t1", "socks")).toBeNull();
    expect(await productQueryInEnglish("t1", "  ")).toBeNull();
    expect(await productQueryInEnglish("", "גרביים")).toBeNull();
    expect(H.gen).not.toHaveBeenCalled();
  });
  it("an answer that is not a few Latin words is not used, and not cached", async () => {
    H.gen.mockImplementation(async () => ({ content: "גרב" }));
    expect(await productQueryInEnglish("t1", "גרביים")).toBeNull();
    H.gen.mockImplementation(async () => ({ content: "Here is the translation: socks for you, enjoy them all day long and more" }));
    expect(await productQueryInEnglish("t1", "גרביים")).toBeNull();
    H.gen.mockImplementation(async () => ({ content: "\"Tank top.\"" }));
    expect(await productQueryInEnglish("t1", "גרביים")).toBe("Tank top");
    expect(H.gen).toHaveBeenCalledTimes(3);
  });
  it("a refusal or a failure is null, and the next search asks again", async () => {
    H.gen.mockImplementation(async () => { throw new Error("credits_exhausted"); });
    expect(await productQueryInEnglish("t1", "גרביים")).toBeNull();
    H.gen.mockImplementation(async () => ({ content: "Socks" }));
    expect(await productQueryInEnglish("t1", "גרביים")).toBe("Socks");
    expect(H.gen).toHaveBeenCalledTimes(2);
  });
});
