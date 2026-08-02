import { describe, it, expect } from "vitest";
import { NODE_REGISTRY } from "../node-registry";
import { FLOW_TEMPLATES } from "../templates";
import { nodeLabel, nodeCategoryLabel, templateName } from "../node-i18n";
import en from "../../../i18n/en.json";
import he from "../../../i18n/he.json";

const enTpl = (en as any).aiStudio.templates as Record<string, { name: string }>;
const heTpl = (he as any).aiStudio.templates as Record<string, { name: string }>;

// Resolve `aiStudio.nodes.<type>.label` the way i18n does (split on ".", so a
// dotted type like voice_trigger:call.incoming lands on the nested key).
function labelFor(root: any, type: string): string | undefined {
  let cur: any = root.aiStudio.nodes;
  for (const part of type.split(".")) cur = cur?.[part];
  return cur?.label;
}

describe("§5 every node type is localized in EN and HE", () => {
  it("§43 all registry node types have EN + HE labels", () => {
    for (const type of Object.keys(NODE_REGISTRY)) {
      expect(labelFor(en, type), `en label for ${type}`).toBeTruthy();
      expect(labelFor(he, type), `he label for ${type}`).toBeTruthy();
    }
  });

  it("§46 Hebrew node labels are actually Hebrew (not leftover English)", () => {
    const hebrew = /[֐-׿]/;
    const labels = Object.keys(NODE_REGISTRY).map((t) => labelFor(he, t) ?? "");
    const withHebrew = labels.filter((l) => hebrew.test(l)).length;
    // Some keep a Latin brand token (AI/Webhook/HTTP); allow a small margin.
    expect(withHebrew).toBeGreaterThanOrEqual(labels.length - 4);
  });
});

describe("§5 every template is localized in EN and HE", () => {
  it("§44 all templates have EN + HE names", () => {
    for (const tpl of FLOW_TEMPLATES) {
      expect(enTpl[tpl.id]?.name, `en name for ${tpl.id}`).toBeTruthy();
      expect(heTpl[tpl.id]?.name, `he name for ${tpl.id}`).toBeTruthy();
    }
  });
});

describe("§5 helpers resolve i18n with graceful fallback", () => {
  const enT = (k: string) => {
    const parts = k.split(".");
    let cur: any = en;
    for (const p of parts) cur = cur?.[p];
    return typeof cur === "string" ? cur : k;
  };
  it("nodeLabel returns the localized string for a known type", () => {
    expect(nodeLabel("send_message_text", enT)).toBe("Send Text");
  });
  it("nodeCategoryLabel localizes a known category", () => {
    expect(nodeCategoryLabel("Messages", enT)).toBe("Messages");
  });
  it("templateName falls back to the provided English name for an unknown id", () => {
    expect(templateName("does_not_exist", enT, "Fallback")).toBe("Fallback");
  });
  it("nodeLabel falls back to the explicit fallback for an unknown legacy type", () => {
    expect(nodeLabel("legacy_unknown", enT, "Legacy Label")).toBe("Legacy Label");
  });
});
