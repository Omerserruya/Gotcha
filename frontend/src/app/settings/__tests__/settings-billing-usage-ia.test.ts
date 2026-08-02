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

  /**
   * The section used to be wrapped in `sub && !isGrandfathered && ...`, so a
   * workspace with no subscription lost the whole concept of cancelling -
   * indistinguishable, to the person looking for it, from a missing button.
   */
  it("Cancellation section renders in every subscription state, including none", () => {
    // The heading is not behind a subscription guard...
    expect(billing).not.toMatch(/\{sub && !isGrandfathered[^\n]*\n\s*<Section title=\{t\("settings\.billing\.cancellation"\)\}/);
    // ...and each state has copy of its own rather than being dropped.
    for (const key of [
      "settings.billing.cancelNothingToCancel",
      "settings.billing.cancelAlreadyCanceled",
      "settings.billing.cancelLegacyPlan",
      "settings.billing.cancelExplain",
    ]) {
      expect(billing, `missing state copy: ${key}`).toContain(key);
    }
  });

  it("payment update opens the dedicated secure route, not an inline prompt", () => {
    expect(billing).toContain("/settings/billing/payment-method");
    // The dev-token prompt moved off the main page into the payment-method route.
    expect(billing).not.toContain("devTokenPrompt");
  });

  it("Adjust Plan flow reports success only after the provider call (navigates on await)", () => {
    const plan = read("app/settings/billing/plan/page.tsx");
    // The configurator applies a change through applyPlanChange and navigates
    // only after that await resolves - never on the click.
    expect(plan).toMatch(/await\s+applyPlanChange\(/);
    expect(plan).toContain('router.push("/settings/billing")');
  });

  it("Adjust Plan sends only KEYS - price and credits are recomputed server-side", () => {
    const plan = read("app/settings/billing/plan/page.tsx");
    // The request body carries plan and volume keys. A price or credit total in
    // the payload would mean the client could choose what it pays.
    const body = plan.slice(plan.indexOf("applyPlanChange(token, {"), plan.indexOf("applyPlanChange(token, {") + 320);
    expect(body).toContain("planKey");
    expect(body).toContain("chatVolumeOptionKey");
    expect(body).not.toMatch(/\bprice\b|\bamount\b|includedCredits/);
  });

  it("Adjust Plan renders the server-supplied estimate disclaimer", () => {
    const plan = read("app/settings/billing/plan/page.tsx");
    // The wording comes from the server rather than being written into the page,
    // so one disclaimer serves every surface and cannot drift per screen.
    expect(plan).toContain("disclaimer");
  });

  it("no customer-facing pricing copy claims the estimate comes from other customers", () => {
    // Every string the customer reads comes from i18n, so that is where the
    // claim would have to live. Checking the page source instead would flag
    // developer comments and miss the copy that actually ships.
    const en = JSON.stringify(JSON.parse(read("i18n/en.json")).settings.billing.pricing);
    const he = JSON.stringify(JSON.parse(read("i18n/he.json")).settings.billing.pricing);
    for (const copy of [en, he]) {
      expect(copy).not.toMatch(/platform average|other customers|average usage|ממוצע הפלטפורמה|לקוחות אחרים/i);
    }
    // And the estimate is labelled as one.
    expect(en).toMatch(/estimated/i);
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
