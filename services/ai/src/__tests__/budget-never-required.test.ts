/**
 * Budget is never required in a shop (2026-10-25, eval R1). In ~20 of 42
 * scenarios Noa asked "מה התקציב?" right after answering, again after a size or
 * a colour, four times in a row in F01, and as a slash menu of brackets.
 */
import { describe, it, expect } from "vitest";
import { buildBudgetRule } from "../services/product-intent.service";
import { OBJECTIVES } from "../services/objectives";
import { profileForStore } from "../services/shopify-facets.service";
import { PRODUCT_RECOMMENDATION_PROFILE } from "@chatcenter/shared";

describe("★ the budget rule", () => {
  it("already asked once: never again", () => {
    const r = buildBudgetRule([{ body: "היי!" }, { body: "יש טווח מחיר שמתאים לך?" }], false);
    expect(r).toMatch(/^BUDGET: do NOT ask about budget/);
    expect(r).toContain("already asked");
  });
  it("a named product (a lookup): do not ask", () => {
    expect(buildBudgetRule([], true)).toMatch(/^BUDGET: do NOT ask about budget/);
  });
  it("otherwise optional, at most once, never a menu or a slash", () => {
    const r = buildBudgetRule([{ body: "כן, יש ב-M" }], false);
    expect(r).toContain("optional, never a condition for showing products");
    expect(r).toContain("at most once in this conversation");
    expect(r).toContain("never as a menu of brackets, never with a slash");
  });
});

describe("★ nothing requires a budget", () => {
  it("the objective", () => {
    const budget = OBJECTIVES.PRODUCT_RECOMMENDATION.requiredInformation.find((f) => f.key === "budget");
    expect(budget?.importance).toBe("preferred");
    expect(OBJECTIVES.PRODUCT_RECOMMENDATION.requiredInformation.filter((f) => f.importance === "required").map((f) => f.key)).toEqual(["product_category"]);
  });
  it("the discovery profile, with or without a catalogue", () => {
    expect(profileForStore(PRODUCT_RECOMMENDATION_PROFILE, null).facts.find((f) => f.key === "budget")?.required).toBe(false);
  });
});
