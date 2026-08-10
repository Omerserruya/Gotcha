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
  it("4. is enabled now that the token is pulled server-side", () => {
    // What changed: client/get_cc_tokens is confirmed, so the success signal is
    // a provider query rather than a browser redirect. The rule itself did not
    // move - checkout still requires BOTH capabilities verified.
    expect(ICOUNT_CAPABILITIES.tokenization).toBe("verified");
    expect(ICOUNT_CAPABILITIES.tokenRetrievalContract).toBe("verified");
    expect(checkoutEnabled(ICOUNT_CAPABILITIES)).toBe(true);
    expect(() => assertCheckoutMayBeEnabled(ICOUNT_CAPABILITIES)).not.toThrow();
  });

  it("4a. would go back to disabled the moment retrieval stopped being verified", () => {
    const regressed = { ...ICOUNT_CAPABILITIES, tokenRetrievalContract: "unverified" as const };
    expect(checkoutEnabled(regressed)).toBe(false);
    expect(() => assertCheckoutMayBeEnabled(regressed)).toThrow(/checkout is disabled/);
  });

  it("4b. the guard is actually reached, not merely defined", () => {
    // It was defined and called by nothing but its own test - which is how its
    // message went on claiming checkout was disabled long after it had been
    // enabled. A guard nothing invokes is not a guard, and worse, it reads like
    // reassurance.
    const progress = read("services/billing/src/services/checkout-progress.service.ts");
    expect(progress).toContain("assertCheckoutMayBeEnabled(getCapabilities(");
    // ...and there is only ONE statement of the rule.
    expect(progress).not.toMatch(/if \(!checkoutEnabled\(/);
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
    // cc/bill now takes an explicit currency_id, but the catalog is priced in
    // USD and charged in ILS through a frozen quote. Submitting USD directly
    // would bypass that, so USD stays unchargeable.
    expect(ICOUNT_CAPABILITIES.chargeCurrencies).not.toContain("USD");
    expect(() => assertChargeCurrency(ICOUNT_CAPABILITIES, "USD")).toThrow(/refusing a USD charge/);
    expect(() => assertChargeCurrency(ICOUNT_CAPABILITIES, "ILS")).not.toThrow();
  });

  it("6b. the provider refuses non-ILS before any network call", () => {
    const provider = read("services/billing/src/providers/icount.provider.ts");
    expect(provider).toContain("assertChargeSafety");
    expect(provider).toMatch(/only ILS charges are enabled/);
  });

  it("6c. the ILS amount comes from a quote, never computed in the adapter", () => {
    const provider = read("services/billing/src/providers/icount.provider.ts");
    const code = provider.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    // A second place the exchange rate lives is a second answer to what the
    // customer owes.
    for (const forbidden of ["fxRate", "activeRate", "convert(", "* rate", "usdIls"]) {
      expect(code, `the adapter must not do its own conversion (${forbidden})`).not.toContain(forbidden);
    }
    expect(provider).toContain("input.chargeAmount");
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
    // Slice the PendingCheckout model precisely. Slicing to the next enum used
    // to work, but PaymentContinuationLink now sits between them and
    // legitimately says "token" throughout - it stores a HASH of one.
    const start = schema.indexOf("model PendingCheckout");
    const model = schema.slice(start, schema.indexOf('@@map("pending_checkouts")', start));
    expect(model).not.toMatch(/\btoken\b/i);

    // And the continuation link stores only a hash, never a raw token.
    const linkStart = schema.indexOf("model PaymentContinuationLink");
    const linkModel = schema.slice(linkStart, schema.indexOf('@@map("payment_continuation_links")', linkStart));
    expect(linkModel).toContain("tokenHash");
    expect(linkModel).not.toMatch(/^\s*token\s+String/m);
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

// ─── The card-entry round trip ──────────────────────────────────

describe("adding a card sends the provider somewhere to return to", () => {
  const routeSrc = readFileSync(join(__dirname, "../routes/payment-methods.ts"), "utf8");
  const route = routeSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const checkoutSrc = readFileSync(join(__dirname, "../routes/checkout-session.ts"), "utf8");

  /**
   * Storing a card is two steps: the provider's page takes it, then OUR server
   * asks the provider what happened. The second step runs when the browser
   * comes back - so without a return URL the provider shows its own thank-you
   * page, the browser never returns, and the confirm never fires.
   *
   * Observed in production: the card was stored at iCount, the tokenization
   * session sat at AWAITING_RETURN until it expired, and the customer was told
   * no card was saved. The plumbing for successUrl existed all the way through
   * to `success_url` on generate_sale; only this call site omitted it, while
   * the checkout route next door passed one.
   */
  it("passes a successUrl when starting a tokenization session", () => {
    expect(route).toMatch(/startTokenizationSession\(\{[\s\S]*?successUrl:/);
  });

  it("builds that URL on our own origin rather than trusting the request", () => {
    expect(route).toContain("buildReturnUrl(");
    // The provider-boundary test already forbids reading a redirect off the
    // request; this keeps the positive half in view next to it.
    expect(route).not.toMatch(/req\.(body|query)\.(successUrl|returnUrl|redirect)/);
  });

  it("degrades instead of blocking when the public origin is unset", () => {
    // A missing return URL costs the round trip. Throwing here would remove
    // the only way to add a card at all.
    expect(route).toMatch(/return undefined/);
  });

  it("stays consistent with the checkout route, which already returned", () => {
    expect(checkoutSrc).toMatch(/successUrl:/);
  });
});

// ─── Removing the last card ─────────────────────────────────────

describe("the last card cannot be removed out from under a live subscription", () => {
  const routeSrc = readFileSync(join(__dirname, "../routes/payment-methods.ts"), "utf8");
  const route = routeSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  /**
   * Reported from production: the only stored card could be removed while a
   * subscription was active. Nothing stopped it, and nothing warned. The next
   * renewal would fail with no_payment_method and the subscription would go
   * PAST_DUE - the customer's first notice being lost access, from an action
   * the UI presented as safe.
   */
  it("counts the other ACTIVE cards before removing", () => {
    expect(route).toMatch(/paymentMethod\.count\(\{[\s\S]*?status: "ACTIVE"[\s\S]*?id: \{ not:/);
  });

  it("refuses with a machine-readable code rather than silently succeeding", () => {
    expect(route).toContain("last_payment_method_in_use");
    expect(route).toMatch(/status\(409\)/);
  });

  it("only protects when a charge is actually still coming", () => {
    // A free/POC plan, or one already cancelling at period end, strands nothing.
    expect(route).toContain("CHARGING_STATUSES");
    expect(route).toContain("cancelAtPeriodEnd");
    expect(route).toMatch(/contractedPrice\(sub, plan\) > 0/);
  });

  it("uses the subscription's contracted price, not the live plan row alone", () => {
    // contractedPrice prefers the immutable snapshot, so republishing a plan
    // cannot change whether a customer is allowed to remove their card.
    expect(route).toContain("contractedPrice");
  });

  it("keeps the cross-tenant scoping that was already there", () => {
    expect(route).toMatch(/billingProfileId: profile\.id/);
  });
});

// ─── The provider's customer id has to survive tokenization ─────

describe("the provider customer id reaches the charge", () => {
  const provSrc = readFileSync(join(__dirname, "../providers/icount.provider.ts"), "utf8");
  const prov = provSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const tokSrc = readFileSync(join(__dirname, "../services/tokenization.service.ts"), "utf8");
  const tok = tokSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  /**
   * iCount will not create a client during generate_sale - it answers
   * client_not_found - so one is created first and returns an id. That id is
   * what cc/bill attributes the charge to.
   *
   * It was created and then discarded. The card stored correctly, the billing
   * profile kept an empty provider_customer_id, and every later charge was
   * refused with "no client identifier - the charge could not be attributed".
   * Observed in production, and the failure surfaced a step removed from its
   * cause, which is why each hop is pinned separately here.
   */
  it("createClient's answer is kept, not discarded", () => {
    expect(prov).toMatch(/const client = await api\.createClient\(/);
    expect(prov).toMatch(/providerClientId: client\.clientId/);
  });

  it("the session records it, preferring what the provider just said", () => {
    expect(tok).toMatch(/providerClientId: start\.providerClientId \?\? input\.providerClientId/);
  });

  it("storing a card carries it onto the billing profile", () => {
    expect(tok).toMatch(/billingProfile\.updateMany\(/);
    expect(tok).toMatch(/providerCustomerId: session\.providerClientId/);
  });

  it("fills it only when empty, so history cannot be reassigned", () => {
    expect(tok).toMatch(/providerCustomerId: null/);
    expect(tok).toMatch(/providerCustomerId: ""/);
  });
});

// ─── A charge refused before it was sent ────────────────────────

describe("a charge that never left the process is a failure, not an unknown", () => {
  const invSrc = readFileSync(join(__dirname, "../services/invoice.service.ts"), "utf8");
  const inv = invSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const provSrc = readFileSync(join(__dirname, "../providers/icount.provider.ts"), "utf8");

  /**
   * Observed in production. assertChargeSafety rejected a charge for a missing
   * client identifier - before any network call - but the Charge row had
   * already been created PENDING, and only an `outcomeUnknown` provider error
   * was handled. The row stayed PENDING for ever.
   *
   * The idempotency lookup reads a PENDING row as "still in flight", so every
   * retry of that key answered outcome-unknown. A clean local misconfiguration
   * became a permanent "we do not know whether we took your money" - the worst
   * state this system has, reached without a single request being sent.
   */
  it("pre-flight refusals carry a neverSent marker", () => {
    expect(provSrc).toContain("class ChargeRefusedBeforeSend");
    expect(provSrc).toContain("readonly neverSent = true");
    expect(provSrc).toContain("no_client_identifier");
  });

  it("every pre-flight guard raises it rather than a bare Error", () => {
    const guard = provSrc.slice(provSrc.indexOf("function assertChargeSafety"), provSrc.indexOf("export const icountProvider"));
    expect(guard).not.toMatch(/throw new Error\(/);
    expect((guard.match(/ChargeRefusedBeforeSend/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("the charge is recorded FAILED, so the row cannot sit PENDING", () => {
    expect(inv).toMatch(/err\?\.neverSent === true/);
    expect(inv).toMatch(/status: "FAILED", failureCode/);
  });

  it("and is NOT reported as outcomeUnknown", () => {
    const branch = inv.slice(inv.indexOf("err?.neverSent === true"), inv.indexOf("if (result.requiresReconciliation)"));
    expect(branch).not.toContain("outcomeUnknown");
  });

  it("still treats a genuine provider ambiguity as unknown", () => {
    // The conservative default has to survive: a mid-flight failure may have
    // taken the money, and retrying it would take it twice.
    expect(inv).toMatch(/err\?\.outcomeUnknown === true/);
    expect(inv).toMatch(/status: "UNKNOWN"/);
  });
});

// ─── Currency ids are the account's, not a guess ────────────────

describe("iCount currency ids match the account", () => {
  /**
   * From the account itself - currency/get_list, cross-checked by
   * currency/info reporting the account's own base currency:
   *
   *   ILS 5    USD 2    EUR 1    GBP 4
   *
   * ILS was 1 here. 1 is EUR. Every "ILS only" guard in this codebase was
   * therefore enforcing euros, and because the wrong value agreed with itself
   * in all three places that defined it, nothing disagreed and nothing failed.
   * A live charge settled as EUR 3.00 instead of ILS 3.00 - about four times
   * the intended amount. On a multi-currency account a wrong currency id does
   * not error, it succeeds for the wrong money, which is the whole reason this
   * is pinned rather than trusted.
   *
   * Both PayPages carried currency_id 5 the entire time. That was the clue.
   */
  const ACCOUNT_IDS = { ILS: 5, USD: 2, EUR: 1, GBP: 4 } as const;

  it("ILS is 5 in the wire constant", () => {
    const client = readFileSync(join(__dirname, "../providers/icount-client.ts"), "utf8");
    expect(client).toContain(`CURRENCY_ID_ILS = ${ACCOUNT_IDS.ILS}`);
  });

  it("ILS is 5 in the quote enum, and USD stays 2", () => {
    const quote = readFileSync(join(__dirname, "../services/payment-quote.service.ts"), "utf8");
    expect(quote).toContain(`ILS: ${ACCOUNT_IDS.ILS}`);
    expect(quote).toContain(`USD: ${ACCOUNT_IDS.USD}`);
  });

  it("ILS is 5 in the chargeable-currency map", () => {
    const caps = readFileSync(join(__dirname, "../providers/capabilities.ts"), "utf8");
    expect(caps).toContain(`{ ILS: ${ACCOUNT_IDS.ILS} }`);
  });

  it("nothing anywhere still calls 1 the shekel", () => {
    // 1 is the euro. Any surviving "ILS: 1" is a charge in the wrong currency.
    for (const rel of [
      "../providers/icount-client.ts",
      "../providers/capabilities.ts",
      "../services/payment-quote.service.ts",
    ]) {
      const src = readFileSync(join(__dirname, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      expect(src, `${rel} still maps ILS to 1`).not.toMatch(/ILS:\s*1\b/);
      expect(src, `${rel} still sets CURRENCY_ID_ILS to 1`).not.toMatch(/CURRENCY_ID_ILS\s*=\s*1\b/);
    }
  });
});
