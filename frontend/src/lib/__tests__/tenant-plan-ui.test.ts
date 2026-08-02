/**
 * What the Sysadmin console is not allowed to show.
 *
 * The failure being prevented is a visual one: a tenant with no plan looking
 * exactly like a paying customer. The console showed status alone, and status
 * is green for an ACTIVE tenant whether or not anyone is entitled to anything -
 * so an organization using the product for free was, on screen, a healthy row.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { billingSelectionComplete, EMPTY_BILLING } from "../../components/system/TenantBilling";

const SRC = join(__dirname, "../..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const page = read("app/system/tenants/page.tsx");
const detail = read("app/system/tenants/[id]/page.tsx");
const billingUi = read("components/system/TenantBilling.tsx");
/** Comments explain why the option was removed; only the CODE is under test. */
const billingCode = billingUi.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("the create form offers exactly two billing types", () => {
  it("no longer offers 'No billing'", () => {
    expect(billingCode).not.toContain("No billing");
    expect(billingCode).not.toContain('"NONE"');
  });

  it("offers Paid plan and POC, and nothing else", () => {
    expect(billingUi).toContain('["PAID_PLAN", "POC"] as BillingMode[]');
  });

  it("defaults to a real decision rather than to no billing", () => {
    expect(EMPTY_BILLING.mode).toBe("PAID_PLAN");
  });
});

describe("the form cannot be submitted half-specified", () => {
  it("a paid plan needs a plan and a server quote", () => {
    expect(billingSelectionComplete({ ...EMPTY_BILLING, mode: "PAID_PLAN" }, false)).toBe(false);
    expect(billingSelectionComplete({ ...EMPTY_BILLING, mode: "PAID_PLAN", planVersionId: "p" }, false)).toBe(false);
    expect(billingSelectionComplete({ ...EMPTY_BILLING, mode: "PAID_PLAN", planVersionId: "p" }, true)).toBe(true);
  });

  it("a POC needs a budget, a future expiry and at least one area", () => {
    const base = { ...EMPTY_BILLING, mode: "POC" as const };
    const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const past = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    expect(billingSelectionComplete(base, false)).toBe(false);
    expect(billingSelectionComplete({ ...base, pocCredits: "5000" }, false)).toBe(false);
    expect(billingSelectionComplete({ ...base, pocCredits: "5000", pocExpiresAt: future }, false)).toBe(false);
    expect(
      billingSelectionComplete({ ...base, pocCredits: "5000", pocExpiresAt: past, pocFeatureAreas: ["conversation"] }, false),
    ).toBe(false);
    expect(
      billingSelectionComplete({ ...base, pocCredits: "5000", pocExpiresAt: future, pocFeatureAreas: ["conversation"] }, false),
    ).toBe(true);
  });
});

describe("no tenant is ever shown without a plan state", () => {
  it("the list renders a plan badge for every row", () => {
    expect(page).toContain("<PlanAccessBadge access={t.planAccess} />");
    expect(page).toContain(">Plan</th>");
  });

  it("the detail page renders one too", () => {
    expect(detail).toContain("<PlanAccessBadge access={tenant.planAccess} />");
  });

  it("an unresolved plan reads as unknown, never as fine", () => {
    // The absent case is the dangerous one: rendering nothing would put a
    // blank cell next to a green status, which reads as healthy.
    expect(billingUi).toContain("Plan unknown");
  });

  it("missing and conflicting plans are shown in the alarming tone", () => {
    const badge = billingUi.slice(billingUi.indexOf("export function PlanAccessBadge"));
    expect(badge).toContain('"MISSING"');
    expect(badge).toContain('"CONFLICTING"');
    expect(badge).toContain("text-red-700");
  });
});

describe("the POC form says what it commits us to", () => {
  it("states plainly that nothing is charged and nothing renews", () => {
    expect(billingUi).toContain("No charge and no renewal");
  });

  it("warns that unselected areas are switched off, not merely unmentioned", () => {
    expect(billingUi).toContain("Anything not selected is switched off");
  });

  it("loads the feature areas from the server instead of hardcoding them", () => {
    expect(billingUi).toContain("getPocFeatureDomains");
  });
});
