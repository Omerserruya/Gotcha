import { describe, it, expect } from "vitest";
import { settingsNav } from "../settings-nav";
import { LEGACY_SETTINGS_REDIRECTS } from "@/lib/settings-routes";
import en from "../../../i18n/en.json";
import he from "../../../i18n/he.json";

const hrefs = settingsNav.map((i) => i.href);

describe("Settings IA", () => {
  it("removed entries are gone from the navigation (Policies, Tools, generic Integrations, standalone Users/Departments/Voice list)", () => {
    for (const gone of [
      "/settings/policy",
      "/settings/tools",
      "/settings/business-rules",
      "/settings/integrations",
      "/settings/users",
      "/settings/departments",
      "/settings/voice-channels",
    ]) {
      expect(hrefs).not.toContain(gone);
    }
  });

  it("has the canonical Workspace destinations in the specified order", () => {
    const workspace = settingsNav.filter((i) => (i.group ?? "workspace") === "workspace").map((i) => i.href);
    expect(workspace.slice(0, 8)).toEqual([
      "/settings",
      "/settings/billing",
      "/settings/usage",
      "/settings/business",
      "/settings/people",
      "/settings/channels",
      "/settings/business-systems",
      "/settings/notifications",
    ]);
  });

  it("groups Account + Security under the personal group", () => {
    const personal = settingsNav.filter((i) => i.group === "personal").map((i) => i.href);
    expect(personal).toEqual(["/settings/account", "/settings/security"]);
  });

  it("every removed route has a redirect to its canonical home", () => {
    for (const gone of ["/settings/users", "/settings/departments", "/settings/integrations", "/settings/tools", "/settings/policy", "/settings/business-rules", "/settings/voice-channels"]) {
      expect(LEGACY_SETTINGS_REDIRECTS[gone]).toBeTruthy();
    }
    // Tool + policy config redirects into AI Studio (canonical owner), never
    // to another Settings page.
    expect(LEGACY_SETTINGS_REDIRECTS["/settings/tools"]).toMatch(/^\/ai-studio\?tab=tools/);
    expect(LEGACY_SETTINGS_REDIRECTS["/settings/policy"]).toMatch(/^\/ai-studio\?tab=tools/);
    expect(LEGACY_SETTINGS_REDIRECTS["/settings/business-rules"]).toMatch(/^\/ai-studio\?tab=tools/);
    // People consolidation keeps deep tabs.
    expect(LEGACY_SETTINGS_REDIRECTS["/settings/users"]).toBe("/settings/people?tab=users");
    expect(LEGACY_SETTINGS_REDIRECTS["/settings/departments"]).toBe("/settings/people?tab=departments");
  });

  it("redirect targets never point at removed routes (no redirect chains into ghosts)", () => {
    for (const target of Object.values(LEGACY_SETTINGS_REDIRECTS)) {
      const path = target.split("?")[0];
      expect(Object.keys(LEGACY_SETTINGS_REDIRECTS)).not.toContain(path);
    }
  });

  it("every nav labelKey resolves in BOTH locales (no raw keys in either language)", () => {
    const resolve = (dict: any, key: string) => key.split(".").reduce((o: any, k) => o?.[k], dict);
    for (const item of settingsNav) {
      if (!item.labelKey) continue;
      expect(typeof resolve(en, item.labelKey), `${item.labelKey} missing in en`).toBe("string");
      expect(typeof resolve(he, item.labelKey), `${item.labelKey} missing in he`).toBe("string");
    }
  });
});
