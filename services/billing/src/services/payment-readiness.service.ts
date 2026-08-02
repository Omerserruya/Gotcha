/**
 * Can this stack actually take a payment, and if not, exactly what is missing.
 *
 * Payment configuration fails in a particularly unhelpful way: every switch
 * defaults OFF for good reasons, so a stack that was never configured looks
 * identical to one that is deliberately closed, and the customer-facing symptom
 * of both is a button that does nothing. Working out which of eight variables
 * was the problem meant reading eight files.
 *
 * Two rules shape what this returns:
 *
 *   Never a secret. Whether a token EXISTS is a configuration fact and is
 *   reported; the token itself is not, and does not appear here in any form -
 *   not truncated, not fingerprinted, not "first four characters".
 *
 *   Never to a customer. The detail is only actionable to whoever administers
 *   the platform, and it names internal capabilities and a provider. Customers
 *   get one sentence saying payment is unavailable; this is for the System
 *   Admin console.
 */
import { appPublicUrl } from "../lib/public-url";
import {
  icountMode,
  icountPaymentPageId,
  icountTestAccountId,
  paymentCapabilityEnabled,
  type IcountMode,
} from "../providers/icount-config";
import { chargingRateConfigured } from "./exchange-rate.service";

/** One thing that has to be true, and whether it is. */
export interface ReadinessCheck {
  key: string;
  /** True when this check passes. */
  ok: boolean;
  /**
   * What an operator would do about it. Present only when `ok` is false, so a
   * green panel carries no busywork.
   */
  action?: string;
  /**
   * A non-secret observed value, where one helps - a mode name, a page id, a
   * hostname. Never a credential.
   */
  detail?: string;
}

export interface PaymentReadiness {
  /** Every check passed: a payment can be started right now. */
  ready: boolean;
  mode: IcountMode;
  /** True only for a mode that can move real money on a real account. */
  liveEnabled: boolean;
  checks: ReadinessCheck[];
  /**
   * The single most useful sentence for whoever is looking - the first failing
   * check, or confirmation that everything is configured.
   */
  summary: string;
}

function check(key: string, ok: boolean, action: string, detail?: string): ReadinessCheck {
  return { key, ok, ...(ok ? {} : { action }), ...(detail ? { detail } : {}) };
}

/**
 * Assemble the picture.
 *
 * Deliberately does NOT call the provider. This answers "is the configuration
 * complete", which must stay answerable when the provider is unreachable -
 * otherwise the panel that exists to diagnose an outage goes blank during one.
 * Whether the PayPage carries an IPN url is a provider question and is asked
 * separately, by the route, so a slow or failing API degrades one row instead
 * of the whole page.
 */
export async function paymentReadiness(): Promise<PaymentReadiness> {
  const mode = icountMode();
  const checks: ReadinessCheck[] = [];

  let publicUrl: string | null = null;
  let publicUrlError: string | null = null;
  try {
    publicUrl = appPublicUrl();
  } catch (err) {
    publicUrlError = (err as Error).message;
  }
  checks.push(
    check(
      "app_public_url",
      Boolean(publicUrl),
      "Set APP_PUBLIC_URL to the origin customers reach this deployment on. Without it a customer has nowhere to return to after paying.",
      publicUrl ?? publicUrlError ?? undefined,
    ),
  );

  // A network mode is what makes the hosted page reachable at all. Mock is a
  // legitimate configuration, so this reports rather than scolds.
  const networkMode = mode === "test" || mode === "live";
  checks.push(
    check(
      "provider_mode",
      networkMode,
      "ICOUNT_MODE is not a network mode, so no hosted payment page exists. Set ICOUNT_MODE=test with ICOUNT_ALLOW_TEST=true to use the test terminal.",
      mode,
    ),
  );

  checks.push(
    check(
      "live_charging_disabled",
      mode !== "live",
      "This stack is configured to charge the production account.",
      mode === "live" ? "live" : "disabled",
    ),
  );

  // Existence only. The value never leaves the process.
  checks.push(
    check(
      "api_token",
      Boolean((process.env.ICOUNT_API_TOKEN || "").trim()),
      "Set ICOUNT_API_TOKEN. The provider cannot be called unauthenticated and there is no fallback.",
      (process.env.ICOUNT_API_TOKEN || "").trim() ? "present" : "missing",
    ),
  );

  if (mode === "test") {
    checks.push(
      check(
        "test_account_pinned",
        Boolean(icountTestAccountId()),
        "Set ICOUNT_TEST_ACCOUNT_ID. Without it nothing verifies that the token belongs to the test terminal rather than the production account.",
        icountTestAccountId() ?? undefined,
      ),
    );
  }

  checks.push(
    check(
      "payment_page",
      Boolean(icountPaymentPageId()),
      "Set ICOUNT_PAYMENT_PAGE_ID to the cc_token PayPage id. Without it there is no page to send a customer to.",
      icountPaymentPageId() ?? undefined,
    ),
  );

  checks.push(
    check(
      "token_encryption_key",
      Boolean((process.env.BILLING_PAYMENT_TOKEN_ENCRYPTION_KEY || "").trim()),
      "Set BILLING_PAYMENT_TOKEN_ENCRYPTION_KEY. A stored card token must not be written unencrypted.",
      (process.env.BILLING_PAYMENT_TOKEN_ENCRYPTION_KEY || "").trim() ? "present" : "missing",
    ),
  );

  for (const capability of ["checkout", "tokenization", "stored_card_charge"] as const) {
    checks.push(
      check(
        `capability_${capability}`,
        paymentCapabilityEnabled(capability),
        `Enable ICOUNT_${capability.toUpperCase()}_ENABLED. The capability is switched off, so this step of checkout is refused.`,
      ),
    );
  }

  // The rate is what makes a USD catalog price a chargeable ILS amount. Without
  // it startPaymentSetup refuses BEFORE sending anyone to a card form, which is
  // the right order but looks like an unexplained dead button.
  let rateOk = false;
  try {
    rateOk = await chargingRateConfigured();
  } catch {
    rateOk = false;
  }
  checks.push(
    check(
      "exchange_rate",
      rateOk,
      "No approved USD/ILS rate is available. Enable BOI_FX_ENABLED or approve a rate; charges are submitted in ILS and cannot be priced without one.",
    ),
  );

  checks.push(
    check(
      "enforcement",
      (process.env.BILLING_ENFORCEMENT_MODE || "").toLowerCase() === "enforce",
      "BILLING_ENFORCEMENT_MODE is not 'enforce', so unpaid organizations are not actually refused.",
      (process.env.BILLING_ENFORCEMENT_MODE || "unset").toLowerCase(),
    ),
  );

  const firstFailure = checks.find((c) => !c.ok);
  return {
    ready: !firstFailure,
    mode,
    liveEnabled: mode === "live",
    checks,
    summary: firstFailure
      ? (firstFailure.action ?? `${firstFailure.key} is not configured`)
      : `Payment is configured and running in ${mode} mode.`,
  };
}

/**
 * The one sentence a CUSTOMER may see when the button cannot work.
 *
 * Maps the internal reason onto something true, short and free of provider
 * detail. A customer learning which environment variable is unset learns
 * something about our infrastructure and nothing about their problem.
 */
export function customerFacingUnavailableReason(readiness: PaymentReadiness): string | null {
  if (readiness.ready) return null;
  const failed = new Set(readiness.checks.filter((c) => !c.ok).map((c) => c.key));

  if (failed.has("exchange_rate")) return "exchange_rate_unavailable";
  if (failed.has("capability_checkout") || failed.has("capability_tokenization")) {
    return "payment_setup_disabled";
  }
  if (failed.has("payment_page") || failed.has("provider_mode") || failed.has("api_token")) {
    return "payment_provider_unavailable";
  }
  return "payment_setup_unavailable";
}
