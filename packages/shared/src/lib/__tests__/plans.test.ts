import { describe, it, expect } from "vitest";
import { PLAN_PRESETS, PLAN_DOMAINS, planDomains } from "../plans";

describe("plans: presets", () => {
  it("light ⊂ pro ⊂ enterprise (monotonic upgrade)", () => {
    const light = new Set(planDomains("light"));
    const pro = new Set(planDomains("pro"));
    const ent = new Set(planDomains("enterprise"));
    for (const d of light) expect(pro.has(d)).toBe(true);
    for (const d of pro) expect(ent.has(d)).toBe(true);
    expect(pro.size).toBeGreaterThan(light.size);
    expect(ent.size).toBeGreaterThan(pro.size);
  });

  it("enterprise entitles every domain", () => {
    expect(new Set(planDomains("enterprise"))).toEqual(new Set(PLAN_DOMAINS));
  });

  it("core domains are in every plan", () => {
    for (const plan of ["light", "pro", "enterprise"] as const) {
      const d = new Set(planDomains(plan));
      for (const core of ["conversation", "customer", "channels", "settings"]) {
        expect(d.has(core as never)).toBe(true);
      }
    }
  });

  it("light excludes premium domains", () => {
    const light = new Set(planDomains("light"));
    for (const premium of ["crm", "ai", "analytics", "integrations", "approvals"]) {
      expect(light.has(premium as never)).toBe(false);
    }
  });

  it("every plan's domains are valid catalog domains", () => {
    const valid = new Set(PLAN_DOMAINS);
    for (const def of Object.values(PLAN_PRESETS)) {
      for (const d of def.domains) expect(valid.has(d)).toBe(true);
    }
  });
});
