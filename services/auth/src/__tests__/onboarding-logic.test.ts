import { describe, it, expect } from "vitest";
import { contentForSnapshot } from "../services/nudge-engine.service";
import { buildDesiredRecommendations } from "../services/recommendations.service";
import type { OnboardingSnapshot } from "../services/onboarding-state.service";

function snap(over: Partial<OnboardingSnapshot> = {}): OnboardingSnapshot {
  return {
    tenantId: "t1", company: "Acme", slug: "acme", status: "PENDING_ONBOARDING",
    createdAt: new Date(), discoveryComplete: false, reviewComplete: false, goalSelected: false,
    crmConnected: false, crmSlug: null, channelsConnected: 0, integrationsConnected: 0,
    knowledgeCount: 0, knowledgeStatus: "none", aiEmployeeCreated: false, aiEmployeeName: null,
    currentStage: "not_started", progressPct: 0, health: "on_track", nextRecommendedAction: "",
    lastActivity: new Date(), lastNudgeSentAt: null, gaps: [], primaryGoal: null, assignedCsm: null,
    ...over,
  };
}

const HEBREW = /[֐-׿]/;

describe("contentForSnapshot (Nudge Engine)", () => {
  it("returns null when live & reachable (active + a channel) — structurally cannot nag", () => {
    expect(contentForSnapshot(snap({ status: "ACTIVE", channelsConnected: 1 }))).toBeNull();
  });

  it("nudges the FIRST unmet milestone (discovery before everything)", () => {
    expect(contentForSnapshot(snap())?.reason).toBe("not_started");
    expect(contentForSnapshot(snap({ discoveryComplete: true, reviewComplete: true }))?.reason).toBe("no_goal");
  });

  it("localizes to Hebrew when locale=he and stays English otherwise", () => {
    const en = contentForSnapshot(snap(), "en");
    const he = contentForSnapshot(snap(), "he");
    expect(en?.reason).toBe("not_started");
    expect(he?.reason).toBe("not_started");
    expect(HEBREW.test(he!.subject)).toBe(true);
    expect(HEBREW.test(en!.subject)).toBe(false);
    expect(he!.headline).not.toBe(en!.headline);
  });
});

describe("buildDesiredRecommendations", () => {
  it("always produces the first-hire rec at top priority", () => {
    const recs = buildDesiredRecommendations({ recommendation: { employeeRole: "sales", employeeName: "Ava" } });
    const hire = recs.find((r) => r.dedupeKey === "hire");
    expect(hire).toBeTruthy();
    expect(hire!.priority).toBe(100);
    expect(hire!.title).toBe("Ava");
  });

  it("ranks already-detected systems above undetected ones", () => {
    const recs = buildDesiredRecommendations({ recommendation: { systems: [{ slug: "shopify", alreadyDetected: true }, { slug: "hubspot" }] } });
    const shop = recs.find((r) => r.dedupeKey === "connect:shopify")!;
    const hub = recs.find((r) => r.dedupeKey === "connect:hubspot")!;
    expect(shop.priority).toBeGreaterThan(hub.priority);
    expect(shop.confidence).toBe("confirmed");
  });

  it("turns honest gaps into teach-me recommendations", () => {
    const recs = buildDesiredRecommendations({ recommendation: {}, gaps: [{ label: "Refund policy", ask: "Paste it" }] });
    expect(recs.some((r) => r.kind === "import_knowledge" && r.dedupeKey.startsWith("gap:"))).toBe(true);
  });

  it("never emits a Connect CTA for detected tools without a connector (tool_detected instead)", () => {
    const recs = buildDesiredRecommendations({
      recommendation: { systems: [{ slug: "shopify", alreadyDetected: true }, { slug: "returngo", alreadyDetected: true }, { slug: "yotpo", alreadyDetected: true }] },
    });
    // Shopify has a real connector → connect_system with a connect action.
    const shop = recs.find((r) => r.dedupeKey === "connect:shopify")!;
    expect(shop.kind).toBe("connect_system");
    expect(shop.action).toBe("connect:shopify");
    // ReturnGO/Yotpo are detected but unsupported → acknowledged, no connect verb.
    for (const slug of ["returngo", "yotpo"]) {
      expect(recs.find((r) => r.dedupeKey === `connect:${slug}`)).toBeUndefined();
      const tool = recs.find((r) => r.dedupeKey === `tool:${slug}`)!;
      expect(tool.kind).toBe("tool_detected");
      expect(tool.title).not.toMatch(/^Connect/);
      expect(tool.action).toBeUndefined();
      expect(tool.priority).toBeLessThan(shop.priority);
    }
  });
});
