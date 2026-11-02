/**
 * A shopper choosing a product is not an issue to diagnose (Tehila,
 * 2026-11-02: a support employee asked for [issue, environment] on
 * "איזה מוצר מתאים לי?").
 */
import { describe, it, expect } from "vitest";
import { detectShoppingTurn } from "../services/product-intent.service";
import { shoppingTurnObjective, selectActiveObjective } from "../services/objectives";
import { computeCurrentPlan } from "../services/planner.service";

describe("detectShoppingTurn", () => {
  it("Tehila's three turns, with a store connected: all shopping (the bare 'כן' too, by its context)", () => {
    expect(detectShoppingTurn(["איזה מוצר מתאים לי?"], true)).toBe(true);
    expect(detectShoppingTurn(["איזה מוצר מתאים לי?", "מטפחות"], true)).toBe(true);
    expect(detectShoppingTurn(["איזה מוצר מתאים לי?", "מטפחות", "כן"], true)).toBe(true);
  });
  it("no store connected: never", () => {
    expect(detectShoppingTurn(["איזה מוצר מתאים לי?"], false)).toBe(false);
  });
  it("an order problem in the newest message wins: not shopping", () => {
    expect(detectShoppingTurn(["איזה מוצר מתאים לי?", "ההזמנה שלי לא הגיעה"], true)).toBe(false);
    expect(detectShoppingTurn(["where is my order"], true)).toBe(false);
  });
});

describe("the objective for a shopping turn", () => {
  const support = selectActiveObjective("customer_support", "UNKNOWN" as any, "", [], true);
  it("support persona, shopping turn: PRODUCT_RECOMMENDATION with nothing to ask first", () => {
    expect(support?.objective.id).toBe("RESOLVE_ISSUE");
    const s = shoppingTurnObjective(support, true);
    expect(s?.objective.id).toBe("PRODUCT_RECOMMENDATION");
    expect(s?.missingRequired).toEqual([]);
  });
  it("not shopping, or another persona's objective: unchanged", () => {
    expect(shoppingTurnObjective(support, false)).toBe(support);
    const sales = selectActiveObjective("sales", "UNKNOWN" as any, "", [], true);
    expect(shoppingTurnObjective(sales, true)).toBe(sales);
    expect(shoppingTurnObjective(null, true)).toBeNull();
  });
  it("the plan acts on it for this turn, and the snapshot carried forward stays the support goal", () => {
    const plan: any = computeCurrentPlan({ role: "customer_support", prospectFlags: { hasLead: false, hasContact: false }, factText: "", shoppingTurn: true } as any);
    const text = JSON.stringify(plan);
    expect(text).toContain("PRODUCT_RECOMMENDATION");
    expect(JSON.stringify(plan.snapshot ?? plan.nextGoalSnapshot ?? {})).not.toContain("PRODUCT_RECOMMENDATION");
  });
});
