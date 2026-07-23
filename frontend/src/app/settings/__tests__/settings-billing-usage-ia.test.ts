import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as apiBilling from "@/lib/api-billing";

// src root, from frontend/src/app/settings/__tests__/
const SRC = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("Billing IA - compact reference hierarchy", () => {
  const billing = read("app/settings/billing/page.tsx");

  it("dedicated flows exist as their own routes", () => {
    for (const p of [
      "app/settings/billing/plan/page.tsx",
      "app/settings/billing/payment-method/page.tsx",
      "app/settings/billing/credits/page.tsx",
      "app/settings/billing/usage-limit/page.tsx",
    ]) {
      expect(existsSync(join(SRC, p)), `${p} should exist`).toBe(true);
    }
  });

  it("main Billing page has NO inline plan-catalog change flow (moved to /settings/billing/plan)", () => {
    // The whole plan grid + change/migrate lived on the main page; it must not anymore.
    expect(billing).not.toMatch(/changePlan\s*\(/);
    expect(billing).not.toMatch(/migratePlan\s*\(/);
    // Instead it links out to the dedicated Adjust plan flow.
    expect(billing).toContain("/settings/billing/plan");
  });

  it("main Billing page has a dedicated Cancellation section gated on settings:billing:cancel", () => {
    expect(billing).toContain("settings.billing.cancellation");
    expect(billing).toContain('can("settings:billing:cancel")');
  });

  it("payment update opens the dedicated secure route, not an inline prompt", () => {
    expect(billing).toContain("/settings/billing/payment-method");
    // The dev-token prompt moved off the main page into the payment-method route.
    expect(billing).not.toContain("devTokenPrompt");
  });

  it("Adjust Plan flow reports success only after the provider call (navigates on await)", () => {
    const plan = read("app/settings/billing/plan/page.tsx");
    expect(plan).toMatch(/await\s*\(migrate\s*\?\s*migratePlan|await\s+changePlan|await\s*\(/);
    expect(plan).toContain('router.push("/settings/billing")');
  });
});

describe("Usage IA - credits only, no tokens/activity", () => {
  const usage = read("app/usage/content.tsx");

  it("reads the canonical credit contract, not analytics/token endpoints", () => {
    expect(usage).toContain("getCreditSummary");
    for (const gone of ["getUsageStats", "getUsageDaily", "getUsageLogs"]) {
      expect(usage, `${gone} must be removed`).not.toContain(gone);
    }
  });

  it("removed the activity dashboard, stat cards and recent-activity table", () => {
    expect(usage).not.toContain("recentActivity");
    expect(usage).not.toContain("usageOverTime");
    expect(usage).not.toContain("ai_tokens");
  });

  it("plan-credit consumption and money-spend are separate concepts", () => {
    expect(usage).toContain("usage.planCredits");
    expect(usage).toContain("usage.usageCredits");
  });

  it("purchase + limit use dedicated flows and cancellation links back to Billing", () => {
    expect(usage).toContain("/settings/billing/credits");
    expect(usage).toContain("/settings/billing/usage-limit");
    expect(usage).toContain('href="/settings/billing"');
  });
});

describe("Credit contract client", () => {
  it("exposes getCreditSummary hitting the canonical endpoint", () => {
    expect(typeof (apiBilling as any).getCreditSummary).toBe("function");
    const src = read("lib/api-billing.ts");
    expect(src).toContain("/api/billing/credit-summary");
    // usageCredits (money) is separate from usage (plan credits) in the type.
    expect(src).toContain("usageCredits");
    expect(src).toContain("purchasedCredits");
  });
});

describe("People & Teams - multiple AI employees per department", () => {
  const dept = read("app/departments/content.tsx");
  it("uses the plural add/remove API, not the single-assign one", () => {
    expect(dept).toContain("getDepartmentAIEmployees");
    expect(dept).toContain("addDepartmentAIEmployee");
    expect(dept).toContain("removeDepartmentAIEmployee");
    expect(dept).not.toContain("assignDepartmentAIEmployee");
  });
  it("renders attached AI employees as a roster (multi), inline in the overview", () => {
    expect(dept).toContain("currentAIEmployees");
    expect(dept).toContain("aiEmployees");
  });
});

describe("Channels - Twilio as a real channel card", () => {
  it("Twilio card opens the Settings-owned page (no 404) and back returns to Channels", () => {
    const channels = read("app/channels/content.tsx");
    expect(channels).toContain("/settings/channels/twilio");
    expect(existsSync(join(SRC, "app/settings/channels/twilio/page.tsx"))).toBe(true);
    const twilio = read("app/settings/channels/twilio/page.tsx");
    expect(twilio).toContain('href="/settings/channels"');
  });
});

describe("Business Systems - connect flow stays inside Settings", () => {
  it("explorer navigation is host-overridable and BS points at a Settings route", () => {
    const explorer = read("components/IntegrationsExplorer.tsx");
    expect(explorer).toContain("detailHref");
    const bs = read("app/settings/business-systems/page.tsx");
    expect(bs).toContain("/settings/business-systems/${slug}");
    // Tool management is AI Studio's job - not the legacy /integrations route.
    expect(bs).not.toContain("/integrations/${toolInfo.slug}");
  });
  it("the Settings provider route reuses one connection with a Settings OAuth return", () => {
    expect(existsSync(join(SRC, "app/settings/business-systems/[provider]/page.tsx"))).toBe(true);
    const provider = read("app/settings/business-systems/[provider]/page.tsx");
    expect(provider).toContain('oauthFlow="settings_business_systems"');
    expect(provider).toContain('backHref="/settings/business-systems"');
  });
});
