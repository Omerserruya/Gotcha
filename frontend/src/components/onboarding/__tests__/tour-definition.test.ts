import { describe, it, expect } from "vitest";
import { ALL_STEPS, REMOVED_STEP_REDIRECTS, resumeStepId } from "../GuidedTour";

describe("guided tour definition", () => {
  it("has unique, sequential steps (renumbering is the array order)", () => {
    const ids = ALL_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("welcome");
    expect(ids[ids.length - 1]).toBe("done");
  });

  it("removed steps never render: their ids are gone from the definition", () => {
    const ids = new Set(ALL_STEPS.map((s) => s.id));
    for (const removed of [
      "channels-nav", // old step 9
      "ai-nav", // old step 12
      "channels-menu",
      "channels",
      "voice-nav",
      "voice",
      "outbound-nav",
    ]) {
      expect(ids.has(removed)).toBe(false);
    }
  });

  it("old steps 18+19 are merged into ONE outbound step with one target", () => {
    const outboundSteps = ALL_STEPS.filter(
      (s) => s.id.startsWith("outbound") || s.navigateTo?.startsWith("/outbound"),
    );
    expect(outboundSteps).toHaveLength(1);
    expect(outboundSteps[0].selector).toBe('[data-tour="outbound-dialer"]');
    expect(outboundSteps[0].navigateTo).toBe("/outbound/call");
  });

  it("visits Settings exactly once, at the closing walkthrough", () => {
    const settingsRouteSteps = ALL_STEPS.filter((s) => s.navigateTo?.startsWith("/settings"));
    expect(settingsRouteSteps).toHaveLength(1);
    expect(settingsRouteSteps[0].id).toBe("settings");
    // The surviving Settings step highlights the COMPLETE settings menu, not
    // a single subsection.
    expect(settingsRouteSteps[0].selector).toBe('[data-tour="settings-nav"]');
    const subsectionTargets = ALL_STEPS.filter((s) => s.selector?.includes("settings-nav-"));
    expect(subsectionTargets).toHaveLength(0);
  });

  it("no step targets the removed early-settings anchors or navigates back to an earlier section", () => {
    const routes = ALL_STEPS.filter((s) => s.navigateTo).map((s) => s.navigateTo!);
    // Settings appears only once and only as the LAST routed section.
    const lastRoute = routes[routes.length - 1];
    expect(lastRoute).toBe("/settings");
    expect(routes.filter((r) => r.startsWith("/settings"))).toHaveLength(1);
  });

  it("every anchored step has bilingual copy and every center step has a CTA", () => {
    for (const s of ALL_STEPS) {
      expect(s.title[0].length).toBeGreaterThan(0);
      expect(s.title[1].length).toBeGreaterThan(0);
      expect(s.body[0].length).toBeGreaterThan(0);
      expect(s.body[1].length).toBeGreaterThan(0);
      // Brand rule: no em/en dash in user-facing copy.
      for (const text of [s.title[0], s.title[1], s.body[0], s.body[1]]) {
        expect(text).not.toMatch(/[\u2014\u2013]/);
      }
      if (s.center) expect(s.cta).toBeDefined();
    }
  });

  describe("persisted-progress migration (resumeStepId)", () => {
    it("keeps a live step id", () => {
      expect(resumeStepId("copilot")).toBe("copilot");
      expect(resumeStepId("settings")).toBe("settings");
    });

    it("redirects every removed id to a surviving step, never a ghost", () => {
      const live = new Set(ALL_STEPS.map((s) => s.id));
      for (const [removed, target] of Object.entries(REMOVED_STEP_REDIRECTS)) {
        expect(live.has(removed)).toBe(false);
        expect(live.has(target)).toBe(true);
        expect(resumeStepId(removed)).toBe(target);
      }
    });

    it("resets unknown/legacy ids and empty state to the first step", () => {
      expect(resumeStepId("some-step-from-2024")).toBe("welcome");
      expect(resumeStepId(null)).toBe("welcome");
    });
  });
});
