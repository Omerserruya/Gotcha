import { describe, it, expect } from "vitest";
import { starterStoreSkills, starterToolNames, STARTER_SKILL_KEYS } from "../services/starter-skills";
import { normalizeSkillInput } from "../services/business-skills.service";
import { getAdapter } from "../services/connectors/integration-framework";
import "../services/connectors";
import { ESCALATE_TOOL, SEND_PRODUCT_CARD_TOOL, SEND_PRODUCT_CAROUSEL_TOOL } from "@chatcenter/shared";

const SYSTEM = new Set<string>([ESCALATE_TOOL, SEND_PRODUCT_CARD_TOOL, SEND_PRODUCT_CAROUSEL_TOOL].map((t: any) => t?.function?.name ?? t?.name));

describe("starter store skills", () => {
  for (const platform of ["shopify", "woocommerce"] as const) {
    for (const locale of ["he", "en"] as const) {
      it(`${platform}/${locale}: every skill passes the editor's validation unchanged`, () => {
        const list = starterStoreSkills(platform, locale);
        expect(list.map((s) => s.key)).toEqual(STARTER_SKILL_KEYS);
        for (const { skill } of list) {
          const n = normalizeSkillInput(skill);
          expect(n.name).toBe(skill.name);
          expect(n.steps?.length).toBe(skill.steps.length);
          expect(n.steps?.map((s) => s.tools)).toEqual(skill.steps.map((s) => s.tools));
          expect(n.status).toBe("active");
        }
      });
    }

    it(`${platform}: every tool a step names is a real ${platform} adapter tool or a system tool`, () => {
      const adapter = getAdapter(platform) as any;
      const real = new Set<string>((adapter?.tools?.() ?? []).map((d: any) => d.name));
      expect(real.size).toBeGreaterThan(5);
      for (const name of starterToolNames(platform)) {
        const ok = name.startsWith(`${platform}.`) ? real.has(name) : SYSTEM.has(name);
        expect(ok, `${platform}: ${name}`).toBe(true);
      }
    });

    it(`${platform}: no tool from the other platform leaks in`, () => {
      const other = platform === "shopify" ? "woocommerce." : "shopify.";
      expect(starterToolNames(platform).filter((n) => n.startsWith(other))).toEqual([]);
    });
  }

  it("Woo has no return tool, so its return skill hands over instead of naming a dead tool", () => {
    const woo = starterStoreSkills("woocommerce", "en").find((s) => s.key === "return_exchange")!;
    expect(woo.skill.steps.some((s) => s.kind === "handover" && s.tools.includes("escalate_to_human"))).toBe(true);
    const shop = starterStoreSkills("shopify", "en").find((s) => s.key === "return_exchange")!;
    expect(shop.skill.steps.some((s) => s.kind === "change" && s.tools.includes("shopify.create_return"))).toBe(true);
  });

  it("writes that change an order need approval", () => {
    for (const p of ["shopify", "woocommerce"] as const) {
      for (const { skill } of starterStoreSkills(p, "en")) {
        for (const s of skill.steps.filter((x) => x.kind === "change")) expect(s.approvalOverAmount, `${p} ${skill.name} ${s.id}`).not.toBeNull();
      }
    }
  });
});
