import { describe, it, expect } from "vitest";
import { legacyGuardrailsFix, readGuardrails, MAX_RULE_LEN } from "../guardrails";

describe("legacyGuardrailsFix: a stored non-list becomes a list the prompt reads (2026-10-21)", () => {
  it("★ text becomes one trimmed rule, which readGuardrails then returns", () => {
    const fix = legacyGuardrailsFix("  Never promise a delivery date.  ");
    expect(fix).toEqual({ action: "set", value: ["Never promise a delivery date."], overLimit: false });
    // The point of the repair: before, the same row read as no rules at all.
    expect(readGuardrails("Never promise a delivery date.")).toEqual([]);
    expect(readGuardrails((fix as any).value)).toEqual(["Never promise a delivery date."]);
  });

  it("empty text and JSON null become no rules", () => {
    expect(legacyGuardrailsFix("   ")).toEqual({ action: "null" });
    expect(legacyGuardrailsFix("")).toEqual({ action: "null" });
    expect(legacyGuardrailsFix(null)).toEqual({ action: "null" });
  });

  it("a list is untouched, even one with odd entries", () => {
    expect(legacyGuardrailsFix(["a", "b"])).toEqual({ action: "keep" });
    expect(legacyGuardrailsFix([1, "b"])).toEqual({ action: "keep" });
  });

  it("★ a rule over the limit is kept whole and flagged, never cut", () => {
    const long = "x".repeat(MAX_RULE_LEN + 5);
    expect(legacyGuardrailsFix(long)).toEqual({ action: "set", value: [long], overLimit: true });
  });

  it("anything else is reported for a person, not guessed at", () => {
    expect(legacyGuardrailsFix(42)).toEqual({ action: "report", reason: "stored as number" });
    expect(legacyGuardrailsFix({ rule: "x" })).toEqual({ action: "report", reason: "stored as object" });
  });
});
