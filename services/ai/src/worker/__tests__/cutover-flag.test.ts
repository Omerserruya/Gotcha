/**
 * Cutover flag tests.
 *
 * The flag is read on every call so changing the env var doesn't need a
 * restart. These tests use the pure variant (`isUnifiedWorkerEnabledFor`)
 * so env mutation doesn't bleed across tests.
 */

import { describe, it, expect } from "vitest";
import { isUnifiedWorkerEnabledFor } from "../cutover-flag";

describe("isUnifiedWorkerEnabledFor", () => {
  it("returns false for every site when the flag is unset or empty", () => {
    for (const raw of [undefined, "", "   "]) {
      expect(isUnifiedWorkerEnabledFor("callpilot", raw)).toBe(false);
      expect(isUnifiedWorkerEnabledFor("copilot", raw)).toBe(false);
      expect(isUnifiedWorkerEnabledFor("autonomous", raw)).toBe(false);
      expect(isUnifiedWorkerEnabledFor("system_copilot_stream", raw)).toBe(false);
    }
  });

  it("returns true for every site when flag is 'all'", () => {
    for (const site of ["callpilot", "copilot", "autonomous", "system_copilot_stream"] as const) {
      expect(isUnifiedWorkerEnabledFor(site, "all")).toBe(true);
    }
  });

  it("accepts 'true' and '1' as full-on aliases", () => {
    expect(isUnifiedWorkerEnabledFor("callpilot", "true")).toBe(true);
    expect(isUnifiedWorkerEnabledFor("callpilot", "1")).toBe(true);
  });

  it("respects per-site comma list (only listed sites enabled)", () => {
    const flag = "callpilot,copilot";
    expect(isUnifiedWorkerEnabledFor("callpilot", flag)).toBe(true);
    expect(isUnifiedWorkerEnabledFor("copilot", flag)).toBe(true);
    expect(isUnifiedWorkerEnabledFor("autonomous", flag)).toBe(false);
  });

  it("tolerates whitespace around comma entries", () => {
    expect(isUnifiedWorkerEnabledFor("callpilot", " callpilot , copilot ")).toBe(true);
    expect(isUnifiedWorkerEnabledFor("autonomous", " callpilot , copilot ")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isUnifiedWorkerEnabledFor("callpilot", "CALLPILOT")).toBe(true);
    expect(isUnifiedWorkerEnabledFor("callpilot", "All")).toBe(true);
  });
});
