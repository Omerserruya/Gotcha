/**
 * An AI employee's free-text rules (B4): one shape (a list of text), one set of
 * limits, refused rather than cut when a person writes them.
 */
import { describe, it, expect } from "vitest";
import { normalizeGuardrails, readGuardrails, clampGuardrails, GuardrailsError, MAX_RULE_LEN, MAX_RULES } from "../lib/guardrails";

const err = (fn: () => unknown) => { try { fn(); } catch (e) { return e as GuardrailsError; } throw new Error("did not throw"); };

describe("normalizeGuardrails", () => {
  it("★ trims, drops empties and exact repeats, keeps order", () => {
    expect(normalizeGuardrails(["  never promise a date ", "", "   ", "never promise a date", "be brief"])).toEqual(["never promise a date", "be brief"]);
    expect(normalizeGuardrails([])).toEqual([]);
  });

  it("★ a string is refused, not stored (the prompt would silently ignore it)", () => {
    expect(err(() => normalizeGuardrails("never promise a date"))).toMatchObject({ code: "GUARDRAILS_INVALID", reason: "not_a_list" });
    expect(err(() => normalizeGuardrails(null))).toMatchObject({ reason: "not_a_list" });
    expect(err(() => normalizeGuardrails(["ok", 3]))).toMatchObject({ reason: "not_text", index: 1 });
  });

  it("★ exactly at the limits passes; one over is refused, never cut", () => {
    expect(normalizeGuardrails(["x".repeat(MAX_RULE_LEN)])[0]).toHaveLength(MAX_RULE_LEN);
    expect(err(() => normalizeGuardrails(["x".repeat(MAX_RULE_LEN + 1)]))).toMatchObject({ reason: "too_long", max: 280, index: 0 });
    const twenty = Array.from({ length: MAX_RULES }, (_, i) => `rule ${i}`);
    expect(normalizeGuardrails(twenty)).toHaveLength(20);
    expect(err(() => normalizeGuardrails([...twenty, "one more"]))).toMatchObject({ reason: "too_many", max: 20 });
  });

  it("repeats do not count toward the limit", () => {
    const twenty = Array.from({ length: MAX_RULES }, (_, i) => `rule ${i}`);
    expect(normalizeGuardrails([...twenty, "rule 0"])).toHaveLength(20);
  });
});

describe("readGuardrails", () => {
  it("the stored value as a list: [] for null or a string", () => {
    expect(readGuardrails(null)).toEqual([]);
    expect(readGuardrails("legacy text")).toEqual([]);
    expect(readGuardrails(["a", 1, " b "])).toEqual(["a", "b"]);
  });
});

describe("clampGuardrails", () => {
  it("★ keeps within the limits without refusing: oldest first, long ones cut", () => {
    const many = Array.from({ length: 25 }, (_, i) => `rule ${i}`);
    const out = clampGuardrails([...many, "y".repeat(400)]);
    expect(out).toHaveLength(20);
    expect(out[0]).toBe("rule 0");
    expect(clampGuardrails(["z".repeat(400)])[0]).toHaveLength(280);
  });
});
