/**
 * Smoovee prod 2026-11-15 (cmwhgsog): a newer message aborted the turn while
 * its reply was being checked. "final gate failed: Request was aborted" was
 * caught, and the unchecked draft went out 17 s before the newer turn's reply
 * (06:44:53 and 06:45:10). At 06:47 the same race sent "בכיף 🙂" to "תעדכנו
 * בבקשה ושלחו לי מספר הזמנה". An aborted turn now sends nothing, unless it
 * already committed something the customer must hear about.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@chatcenter/shared", async (importOriginal) => ({ ...(await importOriginal<any>()) }));

const quiet = () => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
};
const aborted = () => { const c = new AbortController(); c.abort(); return c.signal; };
const base = { escalation: null, awaitingApproval: null, toolCallLog: [] as any[] };

describe("an aborted turn", () => {
  let bot: typeof import("../services/ai-bot.service");
  beforeAll(async () => { bot = await import("../services/ai-bot.service"); }, 120_000);

  it("that only checked its style is dropped as a 499 abort", async () => {
    quiet();
    const { dropIfAborted } = bot;
    const { isAbortError } = await import("../services/turn-cancellation.service");
    const r = { ...base, toolCallLog: [{ tool: "__style_check__", args: {}, result: "", decision: "style_violation" }] };
    let err: any;
    try { dropIfAborted(aborted(), r as any, "c1"); } catch (e) { err = e; }
    expect(err?.status).toBe(499);
    expect(err?.aborted).toBe(true);
    expect(isAbortError(err)).toBe(true);
  });

  it("that ran only reads is dropped", async () => {
    quiet();
    const { dropIfAborted } = bot;
    // Internal checks ("__style_check__") are never an action, whatever they are marked.
    const reads = ["woocommerce.list_products", "woocommerce.get_order", "woocommerce.list_customer_orders", "shopify.search_products", "check_availability", "__style_check__"]
      .map((tool) => ({ tool, args: {}, result: "", decision: "executed" }));
    expect(() => dropIfAborted(aborted(), { ...base, toolCallLog: reads } as any, "c1")).toThrow(/aborted-by-newer-turn/);
  });

  it("that escalated, asked for approval or ran a write still sends", async () => {
    quiet();
    const { dropIfAborted, turnCommitted } = bot;
    const s = aborted();
    expect(() => dropIfAborted(s, { ...base, escalation: { reason: "x" } } as any, "c1")).not.toThrow();
    expect(() => dropIfAborted(s, { ...base, awaitingApproval: { approvalRequestId: "a", tool: "t", reason: "r" } } as any, "c1")).not.toThrow();
    const write = [{ tool: "woocommerce.update_order_status", args: {}, result: "", decision: "executed" }];
    expect(turnCommitted({ ...base, toolCallLog: write } as any)).toBe(true);
    expect(() => dropIfAborted(s, { ...base, toolCallLog: write } as any, "c1")).not.toThrow();
    expect(turnCommitted({ ...base, toolCallLog: [{ tool: "escalate_to_human", args: {}, result: "", decision: "escalate" }] } as any)).toBe(true);
  });

  it("a turn not aborted is never touched", async () => {
    const { dropIfAborted } = bot;
    expect(() => dropIfAborted(new AbortController().signal, base as any, "c1")).not.toThrow();
  });

  it("both the planner turn and the autonomous loop turn go through it", () => {
    const src = readFileSync(join(__dirname, "../services/ai-bot.service.ts"), "utf8");
    expect(src).toContain("const result = await generateAIBotReplyInner(opts, turn.signal);\n    dropIfAborted(turn.signal, result, opts.conversationId);");
    expect(src).toContain('const r = await runAgentLoopForBotTurn(opts, "autonomous", turn.signal);\n        dropIfAborted(turn.signal, r, opts.conversationId);');
  });
});
