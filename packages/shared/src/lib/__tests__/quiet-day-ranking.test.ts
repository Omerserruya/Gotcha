import { describe, it, expect } from "vitest";
import { buildQuietDayList, HORIZON_WEEKS } from "../quiet-day-ranking";

const q = (id: string, askCount: number, weeksObserved = 1) => ({
  id, question: `q-${id}`, reason: "no_knowledge", askCount, askedBy: askCount, weeksObserved,
});
const d = (id: string, askCount: number, weeksRunning = 1) => ({
  id, term: `t-${id}`, askCount, askedBy: askCount, weeksRunning,
});
const build = (o: Partial<Parameters<typeof buildQuietDayList>[0]> = {}) =>
  buildQuietDayList({ unanswered: [], conflicts: [], demand: [], dormant: null, ...o });

describe("buildQuietDayList", () => {
  it("puts four different units on one comparable number", () => {
    const items = build({
      unanswered: [q("a", 10)],
      conflicts: [{ id: "c", fieldKey: "shipping", affectedCustomerCount: 3 }],
      demand: [d("p", 5)],
    });
    expect(items.every((i) => typeof i.wouldRemoveConversations === "number")).toBe(true);
    expect(items.map((i) => i.rank)).toEqual([1, 2, 3]);
  });

  it("ranks by work removed, not by raw count", () => {
    // 10 asks over 10 weeks is one a week; 5 asks in one week is five a week.
    const items = build({ unanswered: [q("slow", 10, 10), q("fast", 5, 1)] });
    expect(items[0]!.id).toBe("fast");
  });

  // The decision this module exists to make.
  it("does NOT rank an opportunity against a chore", () => {
    const items = build({
      unanswered: [q("a", 1)],
      dormant: { count: 640, quietForDays: 60 },
    });
    const dormant = items.find((i) => i.source === "dormant_customers")!;
    expect(dormant.effect).toBe("creates_opportunity");
    // Acting on it CREATES conversations, so scoring it by work removed would
    // put the most valuable item last for being valuable.
    expect(dormant.wouldRemoveConversations).toBeNull();
    // Last, so a client ignoring `effect` still shows the chores first.
    expect(items[items.length - 1]!.source).toBe("dormant_customers");
  });

  it("does not let one disputed field outrank every genuine gap", () => {
    // A conflict is a wrong answer already recorded, not a recurring ask, so
    // its reach is counted once and never multiplied by the horizon.
    const items = build({
      unanswered: [q("gap", 10)],
      conflicts: [{ id: "c", fieldKey: "x", affectedCustomerCount: 10 }],
    });
    const gap = items.find((i) => i.source === "unanswered_question")!;
    const conflict = items.find((i) => i.source === "knowledge_conflict")!;
    expect(conflict.wouldRemoveConversations).toBe(10);
    expect(gap.wouldRemoveConversations!).toBeGreaterThan(conflict.wouldRemoveConversations!);
  });

  it("is conservative: never claims more deflection than asks", () => {
    // Overstating spends the owner's hour on the wrong thing.
    const items = build({ unanswered: [q("a", 10, 1)] });
    expect(items[0]!.wouldRemoveConversations!).toBeLessThanOrEqual(10 * HORIZON_WEEKS);
    expect(items[0]!.wouldRemoveConversations!).toBeLessThan(10 * HORIZON_WEEKS);
  });

  it("shows the counts the estimate was built from", () => {
    const items = build({ unanswered: [q("a", 7, 2)] });
    expect(items[0]!.basis).toMatchObject({ askCount: 7, weeksObserved: 2, horizonWeeks: HORIZON_WEEKS });
  });

  it("carries codes and figures, never a sentence", () => {
    const items = build({ unanswered: [q("a", 3)], demand: [d("p", 4)] });
    for (const i of items) {
      expect(i.kind).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(Object.keys(i)).not.toContain("title");
      expect(Object.keys(i)).not.toContain("description");
    }
  });

  it("orders totally, so paging cannot drop or repeat a row", () => {
    const items = () => build({ unanswered: [q("b", 5), q("a", 5)], demand: [d("c", 5)] }).map((i) => i.id);
    expect(items()).toEqual(items());
  });

  it("omits a dormant card when nobody is dormant", () => {
    expect(build({ dormant: { count: 0, quietForDays: 60 } })).toHaveLength(0);
  });

  it("treats a missing affected count as one customer, not zero", () => {
    const items = build({ conflicts: [{ id: "c", fieldKey: "x", affectedCustomerCount: null }] });
    expect(items[0]!.wouldRemoveConversations).toBe(1);
  });
});
