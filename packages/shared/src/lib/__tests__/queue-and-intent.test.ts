import { describe, it, expect } from "vitest";
import {
  normalizeConversationIntent,
  isConversationIntent,
  isFrustrated,
  CONVERSATION_INTENTS,
} from "../conversation-intent";
import { scoreQueueItem, rankQueueItems } from "../queue-ranking";
import { toActivityEvent, approvalToActivityEvent } from "../activity-events";

const NOW = new Date("2026-09-08T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

describe("normalizeConversationIntent", () => {
  it("passes a value already in the domain straight through", () => {
    // So the day a writer emits these codes, nothing here has to change.
    for (const code of CONVERSATION_INTENTS) {
      expect(normalizeConversationIntent(code)).toBe(code);
    }
  });

  it("maps the five labels the heuristic fallback actually writes", () => {
    expect(normalizeConversationIntent("sales_inquiry")).toBe("HIGH_INTENT");
    expect(normalizeConversationIntent("order_inquiry")).toBe("SHIPPING_ISSUE");
    expect(normalizeConversationIntent("technical_support")).toBe("OTHER");
    expect(normalizeConversationIntent("general")).toBe("OTHER");
  });

  it("does NOT claim a refund request from the billing label", () => {
    // billing's regex covers invoice, bill, payment, charge and subscription as
    // well as refund. Mapping it to REFUND would tell an operator someone wants
    // their money back when they asked when they get billed.
    expect(normalizeConversationIntent("billing")).toBe("OTHER");
  });

  it("classifies the free text the AI producer stores", () => {
    expect(normalizeConversationIntent("customer wants a refund")).toBe("REFUND");
    expect(normalizeConversationIntent("parcel is late")).toBe("SHIPPING_ISSUE");
    expect(normalizeConversationIntent("asking to cancel the order")).toBe("ORDER_CHANGE");
    expect(normalizeConversationIntent("what size should I buy")).toBe("HIGH_INTENT");
    expect(normalizeConversationIntent("waiting on the supplier")).toBe("WAITING_EXTERNAL");
  });

  it("prefers the specific subject over the tone", () => {
    // REFUND says what to DO; FRUSTRATED only says how they feel. Losing the
    // former to gain the latter trades information for mood.
    expect(
      normalizeConversationIntent("furious about the refund", { sentimentScore: -0.9 }),
    ).toBe("REFUND");
  });

  it("falls back to tone when nothing says what it is about", () => {
    expect(normalizeConversationIntent("customer is furious")).toBe("FRUSTRATED");
    expect(normalizeConversationIntent("wants to make a complaint")).toBe("COMPLAINT");
  });

  it("still reports the frustration it declined to put in the subject", () => {
    // The heat must survive somewhere, or a furious refund ranks like a calm one.
    expect(isFrustrated("furious about the refund", { sentimentScore: -0.9 })).toBe(true);
    expect(isFrustrated("wants a refund", {})).toBe(false);
    expect(isFrustrated(null, { sentiment: "negative", customerEffort: 5 })).toBe(true);
    expect(isFrustrated(null, { sentiment: "negative", customerEffort: 2 })).toBe(false);
  });

  it("uses frustration only when the subject is weak", () => {
    expect(normalizeConversationIntent("general", { sentimentScore: -0.8 })).toBe("FRUSTRATED");
    expect(normalizeConversationIntent(null, { sentimentScore: -0.8 })).toBe("FRUSTRATED");
    expect(
      normalizeConversationIntent("unknown", { sentiment: "negative", customerEffort: 5 }),
    ).toBe("FRUSTRATED");
  });

  it("does not read mild negativity as frustration", () => {
    expect(normalizeConversationIntent("general", { sentimentScore: -0.2 })).toBe("OTHER");
    expect(
      normalizeConversationIntent("general", { sentiment: "negative", customerEffort: 2 }),
    ).toBe("OTHER");
  });

  it("returns OTHER for anything it cannot place, never null or the raw value", () => {
    for (const raw of [null, undefined, "", "   ", "zzzz", "unknown"]) {
      const out = normalizeConversationIntent(raw as any);
      expect(isConversationIntent(out)).toBe(true);
      expect(out).toBe(raw === "zzzz" || !raw?.trim() || raw === "unknown" ? "OTHER" : out);
    }
  });
});

describe("scoreQueueItem", () => {
  it("scores a plain wait as its minutes", () => {
    const s = scoreQueueItem(
      { waitingSince: minutesAgo(30), intent: "OTHER", unansweredInbound: 1 },
      NOW,
    );
    expect(s.score).toBe(30);
    expect(s.waitMinutes).toBe(30);
  });

  it("puts a shorter complaint above a longer routine question", () => {
    // The whole reason the ranking is not FIFO.
    const complaint = scoreQueueItem(
      { waitingSince: minutesAgo(20), intent: "COMPLAINT", unansweredInbound: 1 },
      NOW,
    );
    const routine = scoreQueueItem(
      { waitingSince: minutesAgo(45), intent: "OTHER", unansweredInbound: 1 },
      NOW,
    );
    expect(complaint.score).toBeGreaterThan(routine.score);
  });

  it("ranks a customer blocked on a carrier BELOW one we are keeping waiting", () => {
    const external = scoreQueueItem(
      { waitingSince: minutesAgo(60), intent: "WAITING_EXTERNAL", unansweredInbound: 1 },
      NOW,
    );
    const ours = scoreQueueItem(
      { waitingSince: minutesAgo(40), intent: "OTHER", unansweredInbound: 1 },
      NOW,
    );
    expect(external.score).toBeLessThan(ours.score);
  });

  it("lifts a third unanswered message over a single older one", () => {
    // Three messages in five minutes must not sit below one from an hour ago.
    const repeated = scoreQueueItem(
      { waitingSince: minutesAgo(5), intent: "OTHER", unansweredInbound: 3 },
      NOW,
    );
    const single = scoreQueueItem(
      { waitingSince: minutesAgo(40), intent: "OTHER", unansweredInbound: 1 },
      NOW,
    );
    expect(repeated.score).toBeGreaterThan(single.score);
  });

  it("adds nothing for the first message", () => {
    const a = scoreQueueItem({ waitingSince: minutesAgo(10), intent: "OTHER", unansweredInbound: 1 }, NOW);
    const b = scoreQueueItem({ waitingSince: minutesAgo(10), intent: "OTHER", unansweredInbound: 0 }, NOW);
    expect(a.score).toBe(b.score);
  });

  it("grades urgency across the thresholds", () => {
    const at = (m: number) =>
      scoreQueueItem({ waitingSince: minutesAgo(m), intent: "OTHER", unansweredInbound: 1 }, NOW).urgency;
    expect(at(5)).toBe("none");
    expect(at(20)).toBe("low");
    expect(at(90)).toBe("medium");
    expect(at(300)).toBe("high");
  });

  it("scores a frustrated subject row like a complaint, keeping the subject", () => {
    // The pairing that made the split necessary: the chip says REFUND, the
    // score says this is the angriest thing in the queue.
    const angryRefund = scoreQueueItem(
      { waitingSince: minutesAgo(30), intent: "REFUND", unansweredInbound: 1, frustrated: true },
      NOW,
    );
    const calmRefund = scoreQueueItem(
      { waitingSince: minutesAgo(30), intent: "REFUND", unansweredInbound: 1 },
      NOW,
    );
    const complaint = scoreQueueItem(
      { waitingSince: minutesAgo(30), intent: "COMPLAINT", unansweredInbound: 1 },
      NOW,
    );
    expect(angryRefund.score).toBeGreaterThan(calmRefund.score);
    expect(angryRefund.score).toBe(complaint.score);
  });

  it("does not let frustration make a complaint MORE than a complaint", () => {
    const a = scoreQueueItem(
      { waitingSince: minutesAgo(30), intent: "COMPLAINT", unansweredInbound: 1, frustrated: true },
      NOW,
    );
    const b = scoreQueueItem(
      { waitingSince: minutesAgo(30), intent: "COMPLAINT", unansweredInbound: 1 },
      NOW,
    );
    expect(a.score).toBe(b.score);
  });

  it("never scores below zero when a clock runs backwards", () => {
    // Skew between services must not sort a live conversation below everything.
    const future = new Date(NOW.getTime() + 10 * 60_000);
    const s = scoreQueueItem({ waitingSince: future, intent: "OTHER", unansweredInbound: 1 }, NOW);
    expect(s.score).toBe(0);
    expect(s.waitMinutes).toBe(0);
  });
});

describe("rankQueueItems", () => {
  it("orders by score and stamps a 1-based rank", () => {
    const out = rankQueueItems([
      { id: "a", waitingSince: minutesAgo(10), score: 5 },
      { id: "b", waitingSince: minutesAgo(10), score: 90 },
      { id: "c", waitingSince: minutesAgo(10), score: 40 },
    ]);
    expect(out.map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect(out.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("breaks a tie by age, then id, so paging cannot drop or repeat a row", () => {
    const items = [
      { id: "z", waitingSince: minutesAgo(5), score: 50 },
      { id: "a", waitingSince: minutesAgo(5), score: 50 },
      { id: "m", waitingSince: minutesAgo(30), score: 50 },
    ];
    const first = rankQueueItems(items).map((r) => r.id);
    const second = rankQueueItems([...items].reverse()).map((r) => r.id);
    expect(first).toEqual(["m", "a", "z"]); // oldest first, then id
    expect(second).toEqual(first); // total order, independent of input order
  });

  it("does not mutate its input", () => {
    const items = [
      { id: "a", waitingSince: minutesAgo(1), score: 1 },
      { id: "b", waitingSince: minutesAgo(1), score: 2 },
    ];
    rankQueueItems(items);
    expect(items.map((i) => i.id)).toEqual(["a", "b"]);
  });
});

describe("toActivityEvent", () => {
  const base = {
    id: "exec_1",
    createdAt: new Date("2026-09-08T08:12:00.000Z"),
    conversationId: "conv_1",
  };

  it("emits kind + values, never a rendered sentence", () => {
    const e = toActivityEvent({
      ...base,
      toolName: "process_refund",
      input: { orderNumber: "1842" },
      output: { amount: 179, currency: "ILS", customer: "Dana Cohen" },
      success: true,
    });
    expect(e.kind).toBe("refund.completed");
    expect(e.values).toEqual({ amount: 179, currency: "ILS", customer: "Dana Cohen" });
    expect(e.subject).toEqual({ type: "order", id: "1842" });
    expect(e.at).toBe("2026-09-08T08:12:00.000Z");
    // Nothing anywhere that a translator would have to re-parse.
    expect(JSON.stringify(e)).not.toMatch(/Refunded|for order/);
  });

  it("distinguishes a failure from a success on the same tool", () => {
    const e = toActivityEvent({
      ...base, toolName: "process_refund", input: {}, output: {}, success: false,
    });
    expect(e.outcome).toBe("failed");
    expect(e.kind).toBe("refund.failed");
  });

  // SECURITY: input and output are arbitrary provider JSON.
  it("passes through ONLY allow-listed scalars", () => {
    const e = toActivityEvent({
      ...base,
      toolName: "process_refund",
      input: { orderNumber: "1842" },
      output: {
        amount: 179,
        creditCard: "4111111111111111",
        shippingAddress: { line1: "10 Somewhere St" },
        internalNotes: "customer is a nightmare",
      },
      success: true,
    });
    expect(e.values).toEqual({ amount: 179 });
    const json = JSON.stringify(e);
    expect(json).not.toContain("4111");
    expect(json).not.toContain("Somewhere");
    expect(json).not.toContain("nightmare");
  });

  it("keeps one spelling for the customer blank", () => {
    const e = toActivityEvent({
      ...base, toolName: "add_tag", input: { customerName: "Dana" }, output: {}, success: true,
    });
    expect(e.values.customer).toBe("Dana");
    expect(e.values.customerName).toBeUndefined();
  });

  it("prefers the order NUMBER a human recognises over an internal id", () => {
    const e = toActivityEvent({
      ...base,
      toolName: "cancel_order",
      input: {},
      output: { orderNumber: "1842", id: "gid://shopify/Order/99887766" },
      success: true,
    });
    expect(e.subject.id).toBe("1842");
  });

  it("falls back to the slug for an unmapped tool rather than a wrong noun", () => {
    const e = toActivityEvent({
      ...base, toolName: "some_new_tool", input: {}, output: {}, success: true,
    });
    expect(e.kind).toBe("some_new_tool.completed");
    expect(e.subject).toEqual({ type: "none", id: null });
  });
});

describe("approvalToActivityEvent", () => {
  it("puts a pending approval on the same timeline", () => {
    const e = approvalToActivityEvent({
      id: "apr_1",
      tool: "process_refund",
      params: { orderNumber: "1842", amount: 89.5, currency: "ILS" },
      createdAt: new Date("2026-09-08T09:00:00.000Z"),
      conversationId: "conv_2",
    });
    expect(e.outcome).toBe("awaiting_approval");
    expect(e.kind).toBe("refund.awaiting_approval");
    expect(e.subject).toEqual({ type: "order", id: "1842" });
    expect(e.values).toEqual({ amount: 89.5, currency: "ILS" });
  });

  it("treats a dotted integration tool as the same act as its bare form", () => {
    const e = approvalToActivityEvent({
      id: "apr_2",
      tool: "shopify.cancel_order",
      params: { orderNumber: "7" },
      createdAt: new Date("2026-09-08T09:00:00.000Z"),
      conversationId: null,
    });
    expect(e.kind).toBe("order_cancel.awaiting_approval");
  });
});
