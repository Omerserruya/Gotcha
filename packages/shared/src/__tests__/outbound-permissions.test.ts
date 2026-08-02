import { describe, it, expect } from "vitest";
import {
  isPermissionKey,
  BUILTIN_ROLES,
  expandPermissionPatterns,
} from "../lib/permission-catalog";
import { validateE164 } from "../lib/phone-validation";

describe("outbound calling permissions", () => {
  it("registers the outbound call permission keys in the catalog", () => {
    expect(isPermissionKey("outbound:calls:create")).toBe(true);
    expect(isPermissionKey("outbound:calls:view")).toBe(true);
  });

  it("grants outbound calling to every built-in role that could place calls before", () => {
    // admin holds every catalog key (minus owner-only), so expanding its
    // pattern list must include the new keys; agent/department_manager list
    // them explicitly.
    for (const role of ["admin", "department_manager", "agent"] as const) {
      const keys = expandPermissionPatterns(BUILTIN_ROLES[role].permissions);
      expect(keys.has("outbound:calls:create")).toBe(true);
      expect(keys.has("outbound:calls:view")).toBe(true);
    }
  });
});

describe("validateE164 (server-side outbound destination gate)", () => {
  it("accepts plain and formatted E.164 numbers", () => {
    expect(validateE164("+14155551234")).toEqual({ ok: true, normalized: "+14155551234" });
    expect(validateE164("+1 (415) 555-1234")).toEqual({ ok: true, normalized: "+14155551234" });
    expect(validateE164(" +972 52-123-4567 ")).toEqual({ ok: true, normalized: "+972521234567" });
  });

  it("rejects anything that is not a full international number", () => {
    for (const bad of [
      "",
      "0521234567", // local format, no country code - ambiguous
      "+0521234567", // leading zero after +
      "14155551234", // missing +
      "+1", // too short
      "+123456789012345678", // too long
      "+1415555ABCD", // letters
      "'; DROP TABLE calls;--",
    ]) {
      expect(validateE164(bad).ok).toBe(false);
    }
  });
});
