/** The binding verdict's reuse rule, against a stubbed Redis (dev 2026-10-27, urban-e22). */
import { describe, it, expect, vi, beforeEach } from "vitest";
const R = vi.hoisted(() => ({ kv: new Map<string, string>() }));
vi.mock("@chatcenter/shared", async (orig) => ({
  ...(await orig() as any),
  getRedis: () => ({ get: async (k: string) => R.kv.get(k) ?? null, set: async (k: string, v: string) => { R.kv.set(k, v); return "OK"; } }),
}));
import { reusableWizardFacts } from "../services/plan-context.service";

const facts = { evaluated: true, fit: "neutral" } as any;
beforeEach(() => { R.kv.clear(); R.kv.set("ai:wizard-binding:c1", JSON.stringify({ fp: "F", inbound: ["אני מחפש מעיל"], facts })); });

describe("reusableWizardFacts", () => {
  it("reused: same configuration, then only \"סבבה\" or nothing new", async () => {
    expect(await reusableWizardFacts("c1", "F", ["אני מחפש מעיל", "סבבה"])).toEqual(facts);
    expect(await reusableWizardFacts("c1", "F", ["אני מחפש מעיל"])).toEqual(facts);
  });
  it("evaluated again: new words, another configuration, or a different history", async () => {
    expect(await reusableWizardFacts("c1", "F", ["אני מחפש מעיל", "בשבילי לגבר"])).toBeNull();
    expect(await reusableWizardFacts("c1", "G", ["אני מחפש מעיל", "סבבה"])).toBeNull();
    expect(await reusableWizardFacts("c1", "F", ["אני מחפש שמלה", "סבבה"])).toBeNull();
    expect(await reusableWizardFacts("c2", "F", ["סבבה"])).toBeNull();
  });
});
