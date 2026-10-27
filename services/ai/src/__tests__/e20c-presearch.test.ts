/**
 * Latency (a), dev 2026-10-27: the forced search's model round only writes the
 * tool call, so the turn writes it from the category the customer gave and the
 * model answers in one round. Behind AI_PRESEARCH; on by default only on dev.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const F = vi.hoisted(() => ({ facts: new Map<string, any>() }));
vi.mock("@chatcenter/shared", async (orig) => ({ ...(await orig() as any), activeFacts: async () => F.facts }));
import { preSearchEnabled, mentionsAudience, searchQueryFact } from "../services/discovery-integration.service";

describe("the flag", () => {
  it("on with AI_PRESEARCH=1, off with 0; unset: dev only", () => {
    expect(preSearchEnabled({ AI_PRESEARCH: "1", NODE_ENV: "production" } as any)).toBe(true);
    expect(preSearchEnabled({ AI_PRESEARCH: "0", NODE_ENV: "development" } as any)).toBe(false);
    expect(preSearchEnabled({ NODE_ENV: "development" } as any)).toBe(true);
    expect(preSearchEnabled({ NODE_ENV: "production" } as any)).toBe(false);
  });
});

describe("the query: the customer's category, a plain English noun only", () => {
  const q = async (v: unknown) => { F.facts = new Map([["product_category", { valueJson: v }]]); return searchQueryFact("s1"); };
  it("taken", async () => {
    expect(await q("coat")).toBe("coat");
    expect(await q("Leather jacket")).toBe("leather jacket");
  });
  it("left to the model", async () => {
    expect(await q("מעיל מעור")).toBeNull();
    expect(await q("leather_jacket")).toBeNull();
    expect(await q("Cotton Trench Coat by Halvo")).toBeNull();
    expect(await q(500)).toBeNull();
    F.facts = new Map(); expect(await searchQueryFact("s1")).toBeNull();
  });
});

describe("anyone named it is for: the model writes the call (it passes the audience)", () => {
  for (const t of ["בשבילי לגבר", "אני מחפש מתנה לאשתי", "for my wife", "משהו לאבא"]) {
    it(t, () => expect(mentionsAudience([{ direction: "INBOUND", body: t }], "מעיל")).toBe(true));
  }
  for (const t of ["אני מחפש מעיל", "מעיל לבן", "הבנתי"]) it(`not: ${t}`, () => expect(mentionsAudience([], t)).toBe(false));
});

describe("wired", () => {
  const bot = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
  it("round 0 only, through the same dispatch as the model's own call", () => {
    expect(bot).toContain("const preSearch = round === 0 && discoveryPreSearch ? discoveryPreSearch : null;");
    expect(bot).toContain("if (preSearchEnabled() && disc.decision.query && !mentionsAudience(messages as any[], opts.incomingMessage)) {");
    // The synthesized call goes down the normal tool path: no separate executor.
    expect(bot.indexOf("const preSearch = round === 0")).toBeLessThan(bot.indexOf("const toolCalls = response.toolCalls;"));
  });
});
