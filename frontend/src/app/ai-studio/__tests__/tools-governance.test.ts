import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import en from "../../../i18n/en.json";
import he from "../../../i18n/he.json";
import { LEGACY_SETTINGS_REDIRECTS } from "@/lib/settings-routes";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const page = read("app/ai-studio/page.tsx");

describe("§9 no standalone Business Policies tab in AI Studio", () => {
  it("removes 'policies' as a peer sub-view (union + list)", () => {
    // The Tools tab has only three real sub-views now.
    expect(page).toContain('type SkillsSubView = "connected" | "marketplace" | "permissions"');
    expect(page).toContain('const SKILLS_SUB_VIEWS: SkillsSubView[] = ["connected", "marketplace", "permissions"]');
    // There is no longer a peer button/branch that renders ActionPoliciesPanel
    // as its own tab.
    expect(page).not.toContain('setSubView("policies")');
    expect(page).not.toContain('subView === "policies"');
  });

  it("folds the business-policy caps INTO the permissions (governance) surface", () => {
    // ActionPoliciesPanel still renders - but nested under the permissions view,
    // beside the per-tool HITL matrix, not as a standalone tab.
    const permIdx = page.indexOf('subView === "permissions"');
    const toolPanelIdx = page.indexOf("<ToolPermissionsPanel />");
    const policyPanelIdx = page.indexOf("<ActionPoliciesPanel />");
    expect(permIdx).toBeGreaterThan(-1);
    expect(toolPanelIdx).toBeGreaterThan(permIdx);
    expect(policyPanelIdx).toBeGreaterThan(toolPanelIdx);
    // Only ONE render site for each panel (no duplication).
    expect(page.split("<ActionPoliciesPanel />").length - 1).toBe(1);
    expect(page.split("<ToolPermissionsPanel />").length - 1).toBe(1);
  });

  it("aliases old ?view=policies deep-links onto the governance surface", () => {
    expect(page).toContain('if (value === "policies") return "permissions"');
    expect(page).toContain("normalizeSkillsSubView(viewFromUrl)");
  });

  it("the governance tab label is localized in both locales", () => {
    expect((en as any).aiStudio.tools.governanceTab).toBeTruthy();
    expect((he as any).aiStudio.tools.governanceTab).toBeTruthy();
  });
});

describe("§9 legacy policy routes still resolve (no orphaned config path)", () => {
  it("/settings/policy and /settings/business-rules land on the governance surface", () => {
    // Canonical owner is still AI Studio's Tools tab (per the Settings IA),
    // but the specific sub-view is now the unified permissions/governance one.
    expect(LEGACY_SETTINGS_REDIRECTS["/settings/policy"]).toBe("/ai-studio?tab=tools&view=permissions");
    expect(LEGACY_SETTINGS_REDIRECTS["/settings/business-rules"]).toBe("/ai-studio?tab=tools&view=permissions");
    // No redirect points at the now-removed ?view=policies surface.
    for (const target of Object.values(LEGACY_SETTINGS_REDIRECTS)) {
      expect(target).not.toContain("view=policies");
    }
  });
});
