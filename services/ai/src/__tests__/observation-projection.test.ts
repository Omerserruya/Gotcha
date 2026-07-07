/**
 * P1-2 — bounded observation `data` projection. Reads (KNOWLEDGE/CRM/CUSTOM)
 * must re-enter the loop with WHAT they returned, hard-capped for prompt and
 * persistence safety.
 */

import { describe, it, expect } from "vitest";
import { projectObservation, projectData, observationLine } from "../services/agent-loop/observation";

describe("projectData", () => {
  it("returns undefined for empty/absent payloads", () => {
    expect(projectData(undefined)).toBeUndefined();
    expect(projectData({})).toBeUndefined();
  });

  it("caps long strings, arrays, and total size", () => {
    const fat = {
      passages: Array.from({ length: 50 }, (_, i) => "x".repeat(1000) + i),
      note: "y".repeat(5000),
    };
    const s = projectData(fat)!;
    expect(s.length).toBeLessThanOrEqual(1800 + 20); // cap + truncation marker
    expect(s).toContain("…");
  });

  it("keeps small payloads intact and JSON-parseable", () => {
    const s = projectData({ contacts: [{ name: "Dana", email: "d@x.com" }], matchCount: 1 })!;
    expect(JSON.parse(s)).toEqual({ contacts: [{ name: "Dana", email: "d@x.com" }], matchCount: 1 });
  });
});

describe("projectObservation + observationLine", () => {
  it("EXECUTED read carries its data into the loop line", () => {
    const obs = projectObservation("SEARCH_KNOWLEDGE", {
      status: "EXECUTED",
      outcome: "found 2 passages",
      data: { passages: ["Opening hours are 9-17", "We ship worldwide"] },
    } as any);
    expect(obs.data).toContain("Opening hours");
    const line = observationLine(obs);
    expect(line).toContain("SEARCH_KNOWLEDGE → EXECUTED");
    expect(line).toContain("data:");
    expect(line).toContain("ship worldwide");
  });

  it("FAILED carries diagnostic data (e.g. ambiguous-identity candidates)", () => {
    const obs = projectObservation("UPSERT_CUSTOMER", {
      status: "FAILED",
      reason: "ambiguous_identity_needs_operator:2_candidates",
      recoverable: true,
      data: { candidates: [{ id: "a" }, { id: "b" }] },
    } as any);
    expect(obs.data).toContain("candidates");
  });

  it("statuses without data stay unchanged", () => {
    const obs = projectObservation("BOOK_MEETING", { status: "BLOCKED", reason: "not_permitted" } as any);
    expect(obs.data).toBeUndefined();
    expect(observationLine(obs)).toBe("BOOK_MEETING → BLOCKED: not_permitted");
  });
});
