import { describe, it, expect } from "vitest";
import { snapMeetingType } from "../services/schedule-handler.service";

const discovery = { slug: "discovery_call", name: "Discovery Call", durationMinutes: 30 };
const demo = { slug: "product_demo", name: "Product Demo", durationMinutes: 45 };
const audit = { slug: "tech_audit", name: "Technical Audit", durationMinutes: 60 };

describe("snapMeetingType - model invented a meeting_type slug", () => {
  it("single configured type → always use it (the only thing bookable)", () => {
    // The omer/HubSpot tenant case: only `discovery_call` exists, model sent 'demo'.
    expect(snapMeetingType("demo", [discovery])).toEqual(discovery);
    expect(snapMeetingType("anything_at_all", [discovery])).toEqual(discovery);
    expect(snapMeetingType("", [discovery])).toEqual(discovery);
  });

  it("no configured types → null (nothing to book)", () => {
    expect(snapMeetingType("demo", [])).toBeNull();
  });

  it("exact slug / name match wins (case-insensitive)", () => {
    expect(snapMeetingType("DISCOVERY_CALL", [discovery, demo])).toEqual(discovery);
    expect(snapMeetingType("product demo", [discovery, demo])).toEqual(demo);
  });

  it("substring overlap maps to the right type", () => {
    expect(snapMeetingType("demo", [discovery, demo])).toEqual(demo); // 'demo' ⊂ 'product_demo'
    expect(snapMeetingType("audit", [discovery, audit])).toEqual(audit);
  });

  it("intro/demo synonym maps to a discovery-style type when no literal match", () => {
    // 'intro call' has no exact/substring match, but it's an intro synonym → discovery_call
    expect(snapMeetingType("intro call", [discovery, audit])).toEqual(discovery);
    expect(snapMeetingType("שיחת היכרות", [discovery, audit])).toEqual(discovery);
  });

  it("genuinely ambiguous among several → null (ask the model to pick)", () => {
    // 'pricing review' matches neither discovery nor audit by name/synonym.
    expect(snapMeetingType("pricing review", [discovery, audit])).toBeNull();
  });
});
