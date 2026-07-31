import { describe, it, expect } from "vitest";
import { entitledIn, type EntitlementSet } from "../entitlement-resolver";
import { PLANS, CORE_FEATURES, WORKFORCE_FEATURES, VOICE_FEATURES } from "../plan-seeds";
import { FEATURE_CATALOG, getFeatureDef } from "../feature-catalog";

/**
 * What each plan we actually sell does and does not include.
 *
 * The resolver's own tests prove the LAYERING is right (override beats plan,
 * compliance deny beats everything, unbuilt is never sellable). None of them
 * assert the combinations a customer pays for. That gap is how a plan silently
 * gains or loses a capability during a seed edit: every layering test still
 * passes, and Foundation quietly ships AI employees.
 *
 * These run against the real PLANS seeds through the real `entitledIn`, so a
 * seed edit that changes what a plan sells has to change this file too.
 */

/** Build the set `resolveEntitlements` produces for a tenant on this plan. */
function setForPlan(planKey: string): EntitlementSet {
  const plan = PLANS.find((p) => p.key === planKey);
  if (!plan) throw new Error(`no such plan seed: ${planKey}`);
  const entries = new Map();
  // A plan grants exactly its `features`. Everything else carries NO row, so
  // the resolver falls back to the catalog default - the same path a real
  // tenant on this plan takes.
  for (const key of plan.features) {
    entries.set(key, { key, valueType: "BOOLEAN", value: { bool: true }, source: "PLAN_DEFAULT" });
  }
  for (const [key, value] of Object.entries(plan.limits)) {
    entries.set(key, { key, valueType: "COUNTER", value: { count: value }, source: "PLAN_DEFAULT" });
  }
  return { tenantId: `t_${planKey}`, planKey, planVersion: 1, entries, unsubscribed: false };
}

const foundation = setForPlan("foundation");
const workforce = setForPlan("ai_workforce");
const voice = setForPlan("ai_voice");

describe("Foundation sells conversations, not an AI workforce", () => {
  it("does NOT include AI employees", () => {
    expect(entitledIn(foundation, "ai.employee")).toBe(false);
  });

  it("does NOT include the copilot", () => {
    expect(entitledIn(foundation, "ai.copilot")).toBe(false);
  });

  it("DOES include conversation summaries", () => {
    // The requirement that motivated this file. Summaries are a Foundation
    // capability: a customer who bought the cheapest plan still gets them.
    // They must never be reached through ai.employee or ai.copilot, both of
    // which Foundation denies - gating summaries on either would take away a
    // capability the plan sells.
    expect(entitledIn(foundation, "communication.crm_summaries")).toBe(true);
  });

  it("includes no voice capability at all", () => {
    for (const key of VOICE_FEATURES) {
      expect(entitledIn(foundation, key), `foundation must not sell ${key}`).toBe(false);
    }
  });

  it("caps AI employees and voice channels at zero, not at 'unset'", () => {
    // 0 and null read very differently downstream: null means unlimited in
    // `limitIn`. A Foundation plan whose ai_employees limit went missing would
    // grant unlimited employees rather than none.
    expect(foundation.entries.get("limit:ai_employees")?.value).toEqual({ count: 0 });
    expect(foundation.entries.get("limit:voice_channels")?.value).toEqual({ count: 0 });
  });
});

describe("AI Workforce adds the workforce and nothing else", () => {
  it("includes AI employees and the copilot", () => {
    expect(entitledIn(workforce, "ai.employee")).toBe(true);
    expect(entitledIn(workforce, "ai.copilot")).toBe(true);
  });

  it("keeps everything Foundation sold", () => {
    for (const key of CORE_FEATURES) {
      expect(entitledIn(workforce, key), `workforce lost core ${key}`).toBe(true);
    }
  });

  it("still sells no voice", () => {
    for (const key of VOICE_FEATURES) {
      expect(entitledIn(workforce, key), `workforce must not sell ${key}`).toBe(false);
    }
  });

  it("raises the employee cap above zero - otherwise the plan is unusable", () => {
    const cap = (workforce.entries.get("limit:ai_employees")?.value as any)?.count;
    expect(cap).toBeGreaterThan(0);
  });
});

describe("AI Voice is a superset", () => {
  it("includes every voice capability", () => {
    for (const key of VOICE_FEATURES) {
      expect(entitledIn(voice, key), `ai_voice must sell ${key}`).toBe(true);
    }
  });

  it("includes everything the two plans below it sell", () => {
    for (const key of [...CORE_FEATURES, ...WORKFORCE_FEATURES]) {
      expect(entitledIn(voice, key), `ai_voice lost ${key}`).toBe(true);
    }
  });

  it("allows at least one voice channel", () => {
    const cap = (voice.entries.get("limit:voice_channels")?.value as any)?.count;
    expect(cap).toBeGreaterThan(0);
  });
});

describe("the ladder holds in one direction only", () => {
  it("each plan is a strict superset of the one below", () => {
    const f = new Set(PLANS.find((p) => p.key === "foundation")!.features);
    const w = new Set(PLANS.find((p) => p.key === "ai_workforce")!.features);
    const v = new Set(PLANS.find((p) => p.key === "ai_voice")!.features);
    for (const k of f) expect(w.has(k), `ai_workforce dropped ${k}`).toBe(true);
    for (const k of w) expect(v.has(k), `ai_voice dropped ${k}`).toBe(true);
    expect(w.size).toBeGreaterThan(f.size);
    expect(v.size).toBeGreaterThan(w.size);
  });

  it("limits never shrink as the plan gets more expensive", () => {
    const byKey = (k: string) => PLANS.find((p) => p.key === k)!.limits;
    const [f, w, v] = [byKey("foundation"), byKey("ai_workforce"), byKey("ai_voice")];
    for (const key of Object.keys(f)) {
      expect(w[key], `${key} shrank from foundation to ai_workforce`).toBeGreaterThanOrEqual(f[key]);
      expect(v[key], `${key} shrank from ai_workforce to ai_voice`).toBeGreaterThanOrEqual(w[key]);
    }
  });

  it("every feature a plan grants exists in the catalog", () => {
    // A typo'd key in a seed grants nothing and denies nothing - it just sits
    // there looking like a sold capability. The resolver denies uncatalogued
    // keys outright, so the customer silently loses whatever it stood for.
    const known = new Set(FEATURE_CATALOG.map((f) => f.key));
    for (const plan of PLANS) {
      for (const key of plan.features) {
        expect(known.has(key), `plan ${plan.key} grants unknown feature ${key}`).toBe(true);
      }
      for (const key of Object.keys(plan.limits)) {
        expect(known.has(key), `plan ${plan.key} sets unknown limit ${key}`).toBe(true);
      }
    }
  });

  it("no plan grants a capability the product has not built", () => {
    for (const plan of PLANS) {
      for (const key of plan.features) {
        expect(getFeatureDef(key)?.implemented, `plan ${plan.key} sells unbuilt ${key}`).toBe(true);
      }
    }
  });
});

describe("a tenant with no plan at all", () => {
  const none: EntitlementSet = {
    tenantId: "t_none", planKey: null, planVersion: null,
    entries: new Map(), unsubscribed: true,
  };

  it("still gets the always-included core", () => {
    // Pre-billing tenants must keep working. This is the catalog-default path.
    expect(entitledIn(none, "communication.omnichannel")).toBe(true);
    expect(entitledIn(none, "communication.crm_summaries")).toBe(true);
  });

  it("gets no paid capability", () => {
    for (const key of [...WORKFORCE_FEATURES, ...VOICE_FEATURES]) {
      expect(entitledIn(none, key), `unsubscribed tenant must not get ${key}`).toBe(false);
    }
  });

  it("does not get auto-buy - it spends the customer's money", () => {
    expect(entitledIn(none, "commerce.auto_buy")).toBe(false);
  });
});
