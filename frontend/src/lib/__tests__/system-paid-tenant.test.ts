/**
 * Sysadmin paid-tenant UI invariants.
 *
 * The properties here are the ones that would mislead an operator or leak a
 * commercial value if they regressed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tenantBillingUiState } from "../../components/system/TenantBilling";

const SRC = join(__dirname, "../..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const page = read("app/system/tenants/page.tsx");
const billingUi = read("components/system/TenantBilling.tsx");
const client = read("lib/api-system-billing.ts");

describe("pending payment and incomplete setup are distinct states", () => {
  const completed = { state: "COMPLETED", canRepair: false, canResend: true } as any;
  const failed = { state: "FAILED_RETRYABLE", canRepair: true, canResend: false } as any;

  it("33-35. a completed request is ready; anything else is incomplete", () => {
    expect(tenantBillingUiState("PENDING_PAYMENT", completed)).toBe("PENDING_PAYMENT_READY");
    expect(tenantBillingUiState("PENDING_PAYMENT", failed)).toBe("BILLING_SETUP_INCOMPLETE");
    expect(tenantBillingUiState("PENDING_PAYMENT", { state: "PENDING" } as any)).toBe("BILLING_SETUP_INCOMPLETE");
  });

  it("an unknown provisioning state is treated as incomplete, not assumed ready", () => {
    // Guessing "ready" would offer Resend for a checkout that does not exist.
    expect(tenantBillingUiState("PENDING_PAYMENT", null)).toBe("BILLING_SETUP_INCOMPLETE");
    expect(tenantBillingUiState("PENDING_PAYMENT", undefined)).toBe("BILLING_SETUP_INCOMPLETE");
  });

  it("36-37. active and suspended tenants are untouched by billing states", () => {
    expect(tenantBillingUiState("ACTIVE", null)).toBe("ACTIVE");
    expect(tenantBillingUiState("SUSPENDED", null)).toBe("OTHER");
    expect(tenantBillingUiState("PENDING_ONBOARDING", null)).toBe("OTHER");
  });

  it("Resend and Repair are never offered together", () => {
    // The component returns early for the ready state, so only one path renders.
    expect(billingUi).toMatch(/if \(state === "PENDING_PAYMENT_READY"\)[\s\S]{0,400}Resend payment link/);
    expect(billingUi).toMatch(/if \(state !== "BILLING_SETUP_INCOMPLETE"\) return null/);
  });

  it("a permanently failed request offers no Repair button", () => {
    // Retrying would fail identically; the operator must change the plan.
    expect(billingUi).toContain("canRepair ?? true");
    expect(billingUi).toContain("Select a different plan and provision again");
  });
});

describe("the browser never submits or computes a price", () => {
  it("27. only option keys are submitted", () => {
    // The object literal actually sent to createTenant.
    const start = page.indexOf("const res: any = await createTenant(token, {");
    const submit = page.slice(start, page.indexOf("});", start));
    expect(start).toBeGreaterThan(-1);
    expect(submit).toContain("planVersionId");
    expect(submit).toContain("chatVolumeOptionKey");
    for (const f of ["price", "amount", "includedCredits", "currency", "snapshotPrice"]) {
      expect(submit, `must not submit ${f}`).not.toMatch(new RegExp(`\\b${f}\\s*:`));
    }
  });

  it("26. the summary is rendered from the server quote", () => {
    expect(billingUi).toContain("getProvisioningQuote");
    // No local arithmetic on money anywhere in the component.
    expect(billingUi).not.toMatch(/totalAmount\s*[+*/-]\s*/);
    expect(billingUi).not.toMatch(/basePrice\s*\+/);
  });

  it("submission is blocked until the server has quoted", () => {
    // The completeness rule moved into a named function when POC gained its own
    // required fields; a paid plan still cannot be submitted without the
    // server's quote, which is the property this protects.
    expect(page).toContain("billingSelectionComplete(billing, !!quote)");
    expect(billingUi).toContain('if (v.mode === "PAID_PLAN") return !!v.planVersionId && quoted;');
  });

  it("24-25. plans and volume options come from the API, not hardcoded", () => {
    expect(billingUi).toContain("getProvisionablePlans");
    expect(billingUi).toContain("plan?.chatVolumeEnabled");
    expect(billingUi).toContain("plan?.voiceVolumeEnabled");
    // No plan name or price literal in the component. Comments stripped: one
    // explains the "499" vs "499.00" numeric-compare fix and must not trip the
    // check it documents.
    const code = billingUi.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/AI Workforce|Foundation|1499|499\b/);
  });
});

describe("operator-facing copy is honest and safe", () => {
  it("29. warns when the currency cannot be charged yet", () => {
    expect(billingUi).toContain("Payment activation is not yet enabled for this currency");
  });

  it("names no provider, endpoint or internal contract", () => {
    // "token" alone is the AUTH token prop threaded through every admin call;
    // what must never appear is provider or CARD vocabulary.
    for (const leak of ["icount", "paypage", "cc/bill", "doctype", "card token", "cardToken", "tokenization"]) {
      expect(billingUi.toLowerCase(), `UI must not mention ${leak}`).not.toContain(leak.toLowerCase());
    }
  });

  it("31. a failed provisioning does not show a generic success", () => {
    expect(page).toContain("billing setup did not complete");
    expect(page).toContain("Do not create the tenant again");
    expect(page).toContain("No subscription is active and no credits were granted");
  });

  it("32. an email failure offers Resend and does not recreate anything", () => {
    expect(page).toContain("the email did not send");
    expect(page).toContain("were not duplicated");
  });

  it("the repair confirmation states what it does NOT do", () => {
    expect(billingUi).toContain("does not charge the customer");
    expect(billingUi).toContain("grant");
  });

  it("structured backend codes become actionable messages", () => {
    for (const code of [
      "BILLING_PROVISIONING_INCOMPLETE",
      "BILLING_PROVISIONING_ALREADY_COMPLETE",
      "PAYMENT_LINK_RATE_LIMITED",
      "TENANT_NOT_PENDING_PAYMENT",
    ]) {
      expect(page, `unhandled code ${code}`).toContain(code);
    }
  });
});

describe("the client leaks nothing", () => {
  it("never requests or exposes a raw continuation token", () => {
    // The auth bearer token is a parameter here and legitimately named `token`.
    // What must be absent is any CONTINUATION or card token in a response type.
    expect(client.toLowerCase()).not.toContain("continuationtoken");
    expect(client.toLowerCase()).not.toContain("cardtoken");
    expect(client).not.toMatch(/link\s*:\s*\{[^}]*token/);
  });

  it("23. unsupported billing modes are not offered", () => {
    // POC left this list deliberately: it is now one of the two ways an
    // organization can be created, and it has its own required fields and its
    // own explicit entitlement rules on the server. The other three still keep
    // their separate flows - a manual contract in particular activates a paid
    // plan on an operator's word and sits behind a stronger permission.
    for (const mode of ["TRIAL", "CUSTOM_PLAN", "MANUAL_CONTRACT"]) {
      expect(billingUi, `${mode} must not appear in this UI`).not.toContain(mode);
    }
  });
});
