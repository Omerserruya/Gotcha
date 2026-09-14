import { describe, it, expect } from "vitest";
import {
  validateStringList,
  validatePolicyPatch,
  PolicyValidationError,
  MAX_LIST_ITEMS,
  MAX_ITEM_CHARS,
} from "../services/policy.service";

/**
 * These lists are composed verbatim into the AI's system prompt, and the write
 * path used to spread `req.body` into the stored JSON with no checking at all.
 * Everything here defends that boundary: what reaches the model is what an
 * owner actually wrote, in the quantity they wrote it.
 */
describe("validateStringList", () => {
  it("keeps a plain list, trimmed", () => {
    expect(validateStringList("claims", ["  no delivery promises  ", "no medical advice"]))
      .toEqual(["no delivery promises", "no medical advice"]);
  });

  it("refuses a list that is not a list", () => {
    for (const bad of ["a string", 42, null, { 0: "x" }]) {
      expect(() => validateStringList("claims", bad)).toThrow(PolicyValidationError);
    }
  });

  // The one that used to reach the prompt as "1, 2, [object Object]".
  it("refuses non-string entries rather than stringifying them", () => {
    expect(() => validateStringList("claims", ["ok", 2])).toThrow(/must be a string/);
    expect(() => validateStringList("claims", [{ evil: true }])).toThrow(/must be a string/);
  });

  it("caps the number of entries", () => {
    const tooMany = Array.from({ length: MAX_LIST_ITEMS + 1 }, (_, i) => `rule ${i}`);
    expect(() => validateStringList("claims", tooMany)).toThrow(/at most/);
    expect(validateStringList("claims", tooMany.slice(0, MAX_LIST_ITEMS))).toHaveLength(MAX_LIST_ITEMS);
  });

  it("caps the length of one entry", () => {
    expect(() => validateStringList("claims", ["x".repeat(MAX_ITEM_CHARS + 1)])).toThrow(/characters or fewer/);
    expect(validateStringList("claims", ["x".repeat(MAX_ITEM_CHARS)])).toHaveLength(1);
  });

  it("drops an empty row instead of refusing the save", () => {
    // Almost always a leftover blank line in the editor, not an intention.
    expect(validateStringList("claims", ["real rule", "", "   "])).toEqual(["real rule"]);
  });

  it("de-duplicates case-insensitively, so one rule is sent once", () => {
    expect(validateStringList("claims", ["No Refund Promises", "no refund promises"]))
      .toEqual(["No Refund Promises"]);
  });

  it("names the field it rejected, so the editor can point at it", () => {
    try {
      validateStringList("blockedTopics", [1]);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as PolicyValidationError).field).toBe("blockedTopics");
    }
  });
});

describe("validatePolicyPatch", () => {
  it("passes a well-formed patch through", () => {
    expect(validatePolicyPatch({ blockedTopics: ["no legal advice"], maxDiscountPercent: 15 }))
      .toEqual({ blockedTopics: ["no legal advice"], maxDiscountPercent: 15 });
  });

  // A typo that silently persists is worse than a rejection: the owner sees a
  // success, the rule does nothing, and nothing anywhere says so.
  it("rejects an unknown field rather than storing it forever", () => {
    expect(() => validatePolicyPatch({ blockedTopic: ["typo"] })).toThrow(/unknown policy field/);
  });

  it("only touches the fields it was given", () => {
    // A partial patch must not carry defaults that would overwrite a sibling.
    expect(validatePolicyPatch({ blockedTopics: [] })).toEqual({ blockedTopics: [] });
  });

  it("bounds the discount ceiling", () => {
    expect(() => validatePolicyPatch({ maxDiscountPercent: 101 })).toThrow(/between 0 and 100/);
    expect(() => validatePolicyPatch({ maxDiscountPercent: -1 })).toThrow(/between 0 and 100/);
    expect(() => validatePolicyPatch({ maxDiscountPercent: "10" })).toThrow(/must be a number/);
  });

  it("insists a boolean is a boolean", () => {
    expect(() => validatePolicyPatch({ refundRequiresApproval: "yes" })).toThrow(/must be a boolean/);
  });

  it("validates quiet hours as real hours, and accepts clearing them", () => {
    expect(validatePolicyPatch({ outboundQuietHours: { startHour: 22, endHour: 7 } }))
      .toEqual({ outboundQuietHours: { startHour: 22, endHour: 7 } });
    // A window that wraps midnight is the common case and is not an error.
    expect(() => validatePolicyPatch({ outboundQuietHours: { startHour: 24, endHour: 7 } })).toThrow(/0 and 23/);
    expect(validatePolicyPatch({ outboundQuietHours: null })).toEqual({ outboundQuietHours: undefined });
  });

  it("refuses a body that is not an object", () => {
    for (const bad of ["x", 1, null, ["a"]]) {
      expect(() => validatePolicyPatch(bad)).toThrow(PolicyValidationError);
    }
  });
});
