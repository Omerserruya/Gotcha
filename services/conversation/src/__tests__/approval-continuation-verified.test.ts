/**
 * A tool that RAN is not a tool that did the thing.
 *
 * Live (2026-08-02): an approved shipping-address change dispatched cleanly and
 * the tool's own read-back reported `verified: false`. The continuation told
 * the customer their address had been changed - generated from the very result
 * that said it had not, because the outcome was derived from `dispatch.ok`
 * alone.
 *
 * Every write tool in this round reads its own change back. That verdict has to
 * outrank a clean HTTP round trip.
 */
import { describe, it, expect } from "vitest";
import { providerReportedNoChange } from "../routes/approvals";

describe("believing the tool over the transport", () => {
  it("catches the live case: a clean dispatch whose read-back failed", () => {
    expect(providerReportedNoChange({ name: "#1012", address_updated: false, verified: false })).toBe(true);
  });

  it("looks inside the { ok, result } and { ok, output } envelopes", () => {
    expect(providerReportedNoChange({ ok: true, result: { verified: false } })).toBe(true);
    expect(providerReportedNoChange({ ok: true, output: { exchange_completed: false } })).toBe(true);
  });

  it("recognises each tool's own negative flag", () => {
    for (const r of [
      { verified: false },
      { address_updated: false },
      { exchange_completed: false },
      { return_created: false },
      { updated: false },
    ]) {
      expect(providerReportedNoChange(r), JSON.stringify(r)).toBe(true);
    }
  });

  it("treats a verified success as a success", () => {
    expect(providerReportedNoChange({ address_updated: true, verified: true })).toBe(false);
  });

  // Silence is not a claim of failure. Treating it as one would turn every
  // unverified-but-fine write into an alarming message.
  it("does NOT invent a failure from a result that says nothing", () => {
    expect(providerReportedNoChange({ id: 1, name: "#1012" })).toBe(false);
    expect(providerReportedNoChange({})).toBe(false);
    expect(providerReportedNoChange(null)).toBe(false);
    expect(providerReportedNoChange("ok")).toBe(false);
  });
});
