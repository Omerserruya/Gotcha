import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import en from "../../../i18n/en.json";
import he from "../../../i18n/he.json";
import { LEGACY_SETTINGS_REDIRECTS } from "@/lib/settings-routes";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const page = read("app/ai-studio/page.tsx");

describe("§9 ONE governance surface - no standalone policies or tools tab", () => {
  it("the Tools tab has exactly two sub-views: the workspace and the marketplace", () => {
    expect(page).toContain('type SkillsSubView = "workspace" | "marketplace"');
    expect(page).toContain('const SKILLS_SUB_VIEWS: SkillsSubView[] = ["workspace", "marketplace"]');
    // No peer branch renders policies, or a second flat tool list, as its own tab.
    expect(page).not.toContain('setSubView("policies")');
    expect(page).not.toContain('subView === "policies"');
    expect(page).not.toContain('subView === "permissions"');
    expect(page).not.toContain('subView === "connected"');
  });

  it("folds the business-policy caps INTO the workspace surface, below it", () => {
    // The flat per-tool list was replaced by the Integrations & Tools workspace
    // (sidebar + one selected integration). ActionPoliciesPanel still renders
    // beneath it, because those caps bound the financial tools shown above.
    const viewIdx = page.indexOf('subView === "workspace"');
    const workspaceIdx = page.indexOf("<IntegrationWorkspace />");
    const policyPanelIdx = page.indexOf("<ActionPoliciesPanel />");
    expect(viewIdx).toBeGreaterThan(-1);
    expect(workspaceIdx).toBeGreaterThan(viewIdx);
    expect(policyPanelIdx).toBeGreaterThan(workspaceIdx);
    // Only ONE render site for each (no duplicate editable surface).
    expect(page.split("<ActionPoliciesPanel />").length - 1).toBe(1);
    expect(page.split("<IntegrationWorkspace />").length - 1).toBe(1);
  });

  it("every retired sub-view name still resolves instead of 404-ing", () => {
    // ?view=connected, =permissions and =policies were all real, shared URLs.
    // Folding three surfaces into one must not break the links to them.
    for (const legacy of ["connected", "permissions", "policies"]) {
      expect(page).toMatch(new RegExp(`${legacy}:\\s*"workspace"`));
    }
    expect(page).toContain("normalizeSkillsSubView(viewFromUrl)");
    // And an unknown value still falls back rather than rendering nothing.
    expect(page).toContain('normalizeSkillsSubView(viewFromUrl) ?? "workspace"');
  });

  it("the superseded flat tool list is gone, not merely hidden", () => {
    // Two views of the same policy data is how they drift apart. The old list
    // rendered enabled/disabled from a different query than the one the
    // runtime enforces.
    expect(page).not.toContain('t("aiStudio.tools.noneConnected")');
    expect(page).not.toContain("intg.tools.map(");
  });
});

describe("§9 governance surface holds ONLY tool-attached config", () => {
  const governance = read("app/ai-studio/page.tsx");
  const actionPanel = read("components/ai-studio/ActionPoliciesPanel.tsx");

  it("the workspace-wide conversation guardrails (PolicyAdmin) are NOT rendered in the AI Studio Tools surface", () => {
    // PolicyAdmin = escalation keywords / blocked topics / quiet hours / blanket
    // discount ceiling - not attached to a specific executable tool. It must not
    // be imported or rendered anywhere in the governance surface (a doc-comment
    // pointer is fine).
    expect(actionPanel).not.toContain("<PolicyAdmin");
    expect(actionPanel).not.toMatch(/import\s+PolicyAdmin/);
    expect(governance).not.toContain("<PolicyAdmin");
    expect(governance).not.toMatch(/import\s+PolicyAdmin/);
  });

  it("the PolicyAdmin editor is gone from the product entirely", () => {
    // "Your Business" was retired as a product area and the workspace policy
    // EDITOR went with it (explicit product decision). The runtime enforcement
    // engine is untouched - already-configured guardrails keep being applied -
    // but there is no longer a UI surface that mounts this component, so no
    // page may import it.
    expect(existsSync(join(SRC, "components/PolicyAdmin.tsx"))).toBe(false);
    expect(existsSync(join(SRC, "components/business/BusinessTwin.tsx"))).toBe(false);
  });

  it("what stays in the governance surface is tool-attached: the workspace + per-action limits only", () => {
    // IntegrationWorkspace = integration sidebar + per-tool Autonomous/HITL/
    // Disabled + provider scopes. ActionPoliciesPanel = action-specific limits
    // (compensation/coupon/refund/cancel). Both are tool-attached.
    expect(governance).toContain("<IntegrationWorkspace />");
    expect(governance).toContain("<ActionPoliciesPanel />");
    // The action panel is now scoped to per-action caps only (no PolicyAdmin).
    expect(actionPanel).toContain("ACTION_KINDS");
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
