/**
 * Provider-independent checkout infrastructure.
 *
 * These cover the properties that must hold regardless of what iCount's
 * remaining answers turn out to be: page-type validation, capability
 * fail-closed, currency safety, and the attempt state machine that stands
 * between a retry and a second charge.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertTokenizationPage,
  tokenizationPageProblem,
  TOKENIZATION_DOCTYPE,
} from "../providers/icount-paypage";
import {
  ICOUNT_CAPABILITIES,
  MANUAL_CAPABILITIES,
  assertCapability,
  assertChargeCurrency,
  checkoutEnabled,
  CapabilityUnavailableError,
} from "../providers/capabilities";
import { assertCheckoutMayBeEnabled, newCheckoutReference, mayProvisionWithoutCharge } from "../services/checkout.service";
import { mayRetry } from "../services/payment-attempt.service";

const REPO = join(__dirname, "../../../..");
const read = (rel: string) => readFileSync(join(REPO, rel), "utf8");

const goodPage = { doctype: "cc_token", hk_page: 0, is_active: 1, is_deleted: 0 };

// ── 1-3. Page type ──────────────────────────────────────────────────────────

describe("tokenization page validation", () => {
  it("1. accepts cc_token as the tokenization page type", () => {
    expect(TOKENIZATION_DOCTYPE).toBe("cc_token");
    expect(() => assertTokenizationPage(goodPage)).not.toThrow();
    expect(tokenizationPageProblem(goodPage)).toBeNull();
  });

  it("2. rejects invrec, which would charge the customer instead of storing a card", () => {
    expect(() => assertTokenizationPage({ ...goodPage, doctype: "invrec" })).toThrow(
      /immediate-charge checkout page/,
    );
  });

  it("2b. rejects a missing or unknown doctype rather than assuming", () => {
    expect(() => assertTokenizationPage({ ...goodPage, doctype: null })).toThrow(/not "cc_token"/);
    expect(() => assertTokenizationPage({ ...goodPage, doctype: "something_new" })).toThrow(/not "cc_token"/);
  });

  it("3. rejects a standing-order page, which would make iCount a second renewal owner", () => {
    for (const hk of [1, "1", true]) {
      expect(() => assertTokenizationPage({ ...goodPage, hk_page: hk as any })).toThrow(
        /second renewal owner/,
      );
    }
  });

  it("3b. rejects an inactive or deleted page", () => {
    expect(() => assertTokenizationPage({ ...goodPage, is_active: 0 })).toThrow(/not active/);
    expect(() => assertTokenizationPage({ ...goodPage, is_deleted: 1 })).toThrow(/deleted/);
  });
});

// ── 4. Missing contract prevents checkout ───────────────────────────────────

describe("checkout cannot be enabled without a verified token-retrieval contract", () => {
  it("4. is disabled today, because token retrieval is unverified", () => {
    expect(ICOUNT_CAPABILITIES.tokenization).toBe("verified");
    expect(ICOUNT_CAPABILITIES.tokenRetrievalContract).toBe("unverified");
    expect(checkoutEnabled(ICOUNT_CAPABILITIES)).toBe(false);
    expect(() => assertCheckoutMayBeEnabled(ICOUNT_CAPABILITIES)).toThrow(/checkout is disabled/);
  });

  it("4b. would enable only when BOTH tokenization and retrieval are verified", () => {
    expect(checkoutEnabled({ ...ICOUNT_CAPABILITIES, tokenRetrievalContract: "verified" })).toBe(true);
    expect(checkoutEnabled({ ...ICOUNT_CAPABILITIES, tokenization: "unverified", tokenRetrievalContract: "verified" })).toBe(false);
  });

  it("4c. treats 'unverified' exactly like 'unsupported'", () => {
    // The whole point: plausible is not good enough for money.
    expect(() => assertCapability({ ...MANUAL_CAPABILITIES, fullRefund: "unverified" }, "fullRefund")).toThrow(
      CapabilityUnavailableError,
    );
    expect(() => assertCapability(ICOUNT_CAPABILITIES, "storedCardCharge")).not.toThrow();
  });
});

// ── 5-6. Currency ───────────────────────────────────────────────────────────

describe("currency safety", () => {
  it("5. refuses a charge in a currency whose contract is unverified", () => {
    expect(() => assertChargeCurrency(ICOUNT_CAPABILITIES, "EUR")).toThrow(/unverified/);
    expect(() => assertChargeCurrency(ICOUNT_CAPABILITIES, "")).toThrow(/unspecified/);
  });

  it("6. USD cannot silently become ILS", () => {
    // cc/bill has no confirmed currency parameter, so a USD snapshot must be
    // refused rather than submitted and settled in the account base currency.
    expect(ICOUNT_CAPABILITIES.chargeCurrencies).not.toContain("USD");
    expect(() => assertChargeCurrency(ICOUNT_CAPABILITIES, "USD")).toThrow(/refusing a USD charge/);
    expect(() => assertChargeCurrency(ICOUNT_CAPABILITIES, "ILS")).not.toThrow();
  });

  it("6b. the provider refuses non-ILS before any network call", () => {
    const provider = read("services/billing/src/providers/icount.provider.ts");
    expect(provider).toContain("assertChargeSafety");
    expect(provider).toMatch(/refusing \$\{input\.currency\} charge/);
  });
});

// ── 7-10. Attempt state machine ─────────────────────────────────────────────

describe("payment attempt state machine", () => {
  const svc = read("services/billing/src/services/payment-attempt.service.ts");

  it("7. an ambiguous provider outcome becomes UNKNOWN, not FAILED", () => {
    expect(svc).toContain("isAmbiguousFailure");
    expect(svc).toMatch(/ECONNABORTED/);
    expect(svc).toMatch(/setState\(args\.attemptId, "UNKNOWN"/);
  });

  it("8. UNKNOWN is never automatically retried", () => {
    expect(mayRetry("UNKNOWN")).toBe(false);
    expect(mayRetry("MANUAL_REVIEW")).toBe(false);
    expect(mayRetry("SUCCEEDED")).toBe(false);
    expect(mayRetry("PENDING")).toBe(false);
    // Only an explicit provider refusal is safe to repeat.
    expect(mayRetry("FAILED")).toBe(true);
  });

  it("9. database uniqueness prevents a second attempt for the same charge", () => {
    // The unique index is the actual guard - iCount confirmed no provider-side
    // idempotency, so this is the only thing preventing a double charge.
    const schema = read("packages/shared/prisma/schema.prisma");
    expect(schema).toMatch(/attemptKey\s+String\s+@unique/);
    const migration = read(
      "packages/shared/prisma/migrations/20260727100000_pending_checkout_payment_attempt/migration.sql",
    );
    expect(migration).toContain('CREATE UNIQUE INDEX "payment_attempts_attempt_key_key"');
    // A duplicate claim returns the existing row instead of charging again.
    expect(svc).toContain('err?.code !== "P2002"');
    expect(svc).toContain("created: false");
  });

  it("10. ambiguous reconciliation creates MANUAL_REVIEW instead of guessing", () => {
    expect(svc).toMatch(/candidates\.length === 1/);
    expect(svc).toMatch(/candidates\.length === 0/);
    expect(svc).toMatch(/setState\(args\.attemptId, "MANUAL_REVIEW"/);
    expect(svc).toContain("ambiguous:");
  });

  it("10b. a provider with no lookup goes to MANUAL_REVIEW rather than assuming failure", () => {
    expect(svc).toContain("provider has no transaction lookup");
  });
});

// ── 11-12. Refunds ──────────────────────────────────────────────────────────

describe("refund fail-closed", () => {
  const provider = read("services/billing/src/providers/icount.provider.ts");

  it("11. a refund without a document reference is rejected", () => {
    expect(provider).toContain("missing_document_reference");
  });

  it("12. a partial refund is rejected until its contract is verified", () => {
    expect(ICOUNT_CAPABILITIES.partialRefund).toBe("unsupported");
    expect(provider).toContain("partial_refund_unsupported");
    expect(() => assertCapability(ICOUNT_CAPABILITIES, "partialRefund")).toThrow();
  });
});

// ── 13-15. Structural safety ────────────────────────────────────────────────

describe("structural safety", () => {
  it("13. no browser redirect can activate a subscription", () => {
    const checkout = read("services/billing/src/services/checkout.service.ts");
    // The callback carries only an opaque reference; terms come from the frozen
    // snapshot, and nothing commercial is accepted from the client.
    expect(checkout).toContain("findByReference");
    expect(checkout).toContain("contractedTerms");
    expect(checkout).not.toMatch(/activateOrRenew|status:\s*"ACTIVE"/);
    // A successful tokenization is explicitly not payment.
    expect(mayProvisionWithoutCharge({ trialBehavior: "none" })).toBe(false);
    expect(mayProvisionWithoutCharge({ trialBehavior: "trial" })).toBe(true);
  });

  it("13b. the checkout reference is opaque and unguessable", () => {
    const a = newCheckoutReference();
    const b = newCheckoutReference();
    expect(a).toMatch(/^chk_[A-Za-z0-9_-]{30,}$/);
    expect(a).not.toBe(b);
  });

  it("14. no card token or API token reaches frontend state or URLs", () => {
    const checkout = read("services/billing/src/services/checkout.service.ts");
    expect(checkout).not.toMatch(/\btoken\b\s*:/); // no token field on the checkout record
    const schema = read("packages/shared/prisma/schema.prisma");
    const model = schema.slice(schema.indexOf("model PendingCheckout"), schema.indexOf("enum PaymentAttemptState"));
    expect(model).not.toMatch(/\btoken\b/i);
  });

  it("15. live charging remains disabled by default", () => {
    const env = read(".env.example");
    expect(env).toMatch(/^ICOUNT_MODE=mock$/m);
    expect(env).toMatch(/^ICOUNT_ALLOW_LIVE=false$/m);
    const provider = read("services/billing/src/providers/icount.provider.ts");
    expect(provider).toContain('process.env.ICOUNT_ALLOW_LIVE === "true"');
    expect(provider).toContain('process.env.NODE_ENV === "production"');
  });
});
