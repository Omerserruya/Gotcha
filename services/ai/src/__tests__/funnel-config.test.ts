import { describe, it, expect } from "vitest";
import {
  resolveFunnel,
  SAAS_DEFAULT_FUNNEL,
  SERVICE_DEFAULT_FUNNEL,
} from "../services/funnel-config.service";

describe("FunnelConfig - resolveFunnel", () => {
  it("returns null stage + unchanged strategy when no funnel provided", () => {
    const r = resolveFunnel({
      funnel: null,
      baseStage: "initial",
      intent: "informational",
      userType: "new_lead",
      strategy: "QUALIFY",
      lastMessage: "hi",
    });
    expect(r.stageId).toBeNull();
    expect(r.strategy).toBe("QUALIFY");
    expect(r.playbookIds).toBeNull();
    expect(r.appliedReasons).toEqual([]);
  });

  it("SaaS funnel: 'demo' marker on initial stage → demo stage anchored to exploration", () => {
    // Marker is checked against entry guard; baseStage is `exploration`.
    const r = resolveFunnel({
      funnel: SAAS_DEFAULT_FUNNEL,
      baseStage: "exploration",
      intent: "informational",
      userType: "new_lead",
      strategy: "QUALIFY",
      lastMessage: "can I see a demo of the product",
    });
    expect(r.stageId).toBe("demo");
  });

  it("SaaS funnel: demo stage + informational → strategy override → CONVERT", () => {
    const r = resolveFunnel({
      funnel: SAAS_DEFAULT_FUNNEL,
      baseStage: "exploration",
      intent: "informational",
      userType: "new_lead",
      strategy: "QUALIFY",
      lastMessage: "i want a demo please",
    });
    expect(r.stageId).toBe("demo");
    expect(r.strategy).toBe("CONVERT");
    expect(r.appliedReasons.some((x) => x.includes("demo-stage informational"))).toBe(true);
  });

  it("SaaS funnel: qualified stage + QUALIFY → playbook override applied", () => {
    const r = resolveFunnel({
      funnel: SAAS_DEFAULT_FUNNEL,
      baseStage: "exploration",
      intent: "informational",
      userType: "new_lead",
      strategy: "QUALIFY",
      lastMessage: "i'm exploring tools for my team",
    });
    expect(r.stageId).toBe("qualified");
    expect(r.playbookIds).toEqual(["lead_qualification", "demo_request"]);
  });

  it("Service funnel: quote marker → quoted stage", () => {
    const r = resolveFunnel({
      funnel: SERVICE_DEFAULT_FUNNEL,
      baseStage: "exploration",
      intent: "informational",
      userType: "new_lead",
      strategy: "QUALIFY",
      lastMessage: "can you send me a quote for next month?",
    });
    expect(r.stageId).toBe("quoted");
  });

  it("Service funnel: quoted + informational → CONVERT override", () => {
    const r = resolveFunnel({
      funnel: SERVICE_DEFAULT_FUNNEL,
      baseStage: "exploration",
      intent: "informational",
      userType: "new_lead",
      strategy: "QUALIFY",
      lastMessage: "i'd like a quote please",
    });
    expect(r.strategy).toBe("CONVERT");
  });

  it("entry guard misses → falls through to next matching stage", () => {
    // SaaS qualified guard requires intent in informational/transactional.
    // 'unclear' must NOT enter `qualified`; should fall to `demo` only if marker, else stay no-stage match.
    const r = resolveFunnel({
      funnel: SAAS_DEFAULT_FUNNEL,
      baseStage: "exploration",
      intent: "unclear",
      userType: "new_lead",
      strategy: "QUALIFY",
      lastMessage: "hmm",
    });
    expect(r.stageId).toBeNull();
  });
});
