/**
 * Shopify billing configuration and flags.
 *
 * Modelled directly on `providers/icount-config.ts`, including the part that
 * matters most: **anything not explicitly acknowledged degrades to `mock`.** A
 * billing integration that switches itself on eventually charges somebody by
 * accident, and the whole point of a rollout flag is that the default is the
 * state production is already in.
 *
 * Config (billing service only - never NEXT_PUBLIC, none of these are secrets
 * except where noted):
 *
 *   SHOPIFY_BILLING_ENABLED        "false" (default) - the master switch
 *   SHOPIFY_BILLING_MODE           "app_pricing" | "manual" - unset => disabled
 *   SHOPIFY_BILLING_ENV            "mock" (default) | "test" | "live"
 *   SHOPIFY_ALLOW_LIVE_BILLING     explicit acknowledgement required for live
 *   SHOPIFY_BILLING_POLICY_MODE    "full" | "connector_addon" | "grandfathered_only"
 *   SHOPIFY_ALLOW_SPLIT_BILLING    "false" - Shopify has not confirmed this
 *   SHOPIFY_ALLOW_GRANDFATHERED    "false" - never grandfather by default
 *   SHOPIFY_USAGE_BILLING_ENABLED  "false" - metered dispatch off until proven
 *   SHOPIFY_APP_HANDLE             app handle used to build the plan-select URL
 *   SHOPIFY_BILLING_PLAN_HANDLES   JSON map productKey -> plan handle
 *   SHOPIFY_USAGE_METER_HANDLES    JSON map metric -> meter handle
 *   SHOPIFY_BILLING_PLAN_CATALOG   JSON plan catalog. REQUIRED for app_pricing
 *                                  in every environment - see the assertion.
 *   SHOPIFY_APP_PUBLICATION_CUTOFF ISO 8601. The grandfathering line.
 *   SHOPIFY_GRANDFATHER_DEV_STORES "false" - dev stores are not auto-granted
 *   SHOPIFY_PARTNER_API_TOKEN      SECRET. App Pricing verification.
 *   SHOPIFY_PARTNER_ORGANIZATION_ID
 *   SHOPIFY_PARTNER_APP_ID         All THREE are required together whenever
 *                                  app_pricing runs in test or live.
 *   SHOPIFY_APP_EVENTS_CLIENT_ID / SHOPIFY_APP_EVENTS_CLIENT_SECRET
 *                                  SECRET. client_credentials for App Events.
 *
 * Plan handles and prices are NOT defined here and must never be. Under Shopify
 * App Pricing the plans live in the Partner Dashboard and cannot be
 * version-controlled; inventing a price in code would produce a number that
 * disagrees with the one the merchant was actually shown.
 */

import { strictShopDomain } from "@chatcenter/shared";

import { sellablePlans, validatePlanCatalog } from "./plan-catalog";

/** Which Shopify billing mechanism this deployment uses. */
export type ShopifyBillingMode = "app_pricing" | "manual" | "disabled";

/**
 * Deployment environment for Shopify billing.
 *
 * `mock` performs no network call and can charge nothing. It is the default so
 * that a stack which was never configured cannot reach Shopify at all.
 * `test` reaches Shopify against development stores, where Shopify itself
 * applies $0 prices. `live` is real money.
 */
export type ShopifyBillingEnv = "mock" | "test" | "live";

/** Which commercial arrangement the resolver is permitted to reach. */
export type ShopifyPolicyMode = "full" | "connector_addon" | "grandfathered_only";

/**
 * Takes the VALUE, not the variable name, deliberately.
 *
 * `flag("SHOPIFY_X")` reading `process.env[name]` would be tidier to call, and
 * it would make every one of these invisible to
 * `__tests__/env-wiring.test.ts`, which finds a service's configuration by
 * scanning for the literal text `process.env.SOMETHING`. That guard exists
 * because an undeclared variable is silently `undefined` and the code just
 * takes its default - the exact failure that left BILLING_ENFORCEMENT_MODE
 * inert in production. An indirection that hides variables from it is worth
 * more than the small ugliness at the call site.
 */
function flag(raw: string | undefined, fallback = false): boolean {
  if (raw === undefined || raw === "") return fallback;
  return String(raw).toLowerCase() === "true";
}

/** The master switch. Everything else is irrelevant while this is off. */
export function shopifyBillingEnabled(): boolean {
  return flag(process.env.SHOPIFY_BILLING_ENABLED, false);
}

/**
 * The mechanism in use.
 *
 * Returns "disabled" unless the master switch is on AND a mode was named. An
 * unrecognised value is "disabled" rather than a guess: a typo in a billing
 * mode must not silently select a way of charging people.
 */
export function shopifyBillingMode(): ShopifyBillingMode {
  if (!shopifyBillingEnabled()) return "disabled";
  const raw = String(process.env.SHOPIFY_BILLING_MODE || "").toLowerCase().trim();
  if (raw === "app_pricing") return "app_pricing";
  if (raw === "manual") return "manual";
  return "disabled";
}

/**
 * Which environment we are configured to talk to.
 *
 * `live` requires SHOPIFY_ALLOW_LIVE_BILLING as a separate, explicit
 * acknowledgement - same shape as ICOUNT_ALLOW_LIVE, and for the same reason:
 * one variable set by accident should never be enough to move real money.
 */
export function shopifyBillingEnv(): ShopifyBillingEnv {
  const raw = String(process.env.SHOPIFY_BILLING_ENV || "mock").toLowerCase().trim();
  if (raw === "live") return flag(process.env.SHOPIFY_ALLOW_LIVE_BILLING) ? "live" : "mock";
  if (raw === "test") return "test";
  return "mock";
}

/** True for every mode that performs no network call and can charge nothing. */
export function isShopifyBillingMock(): boolean {
  return shopifyBillingEnv() === "mock";
}

/** Every mode that performs real HTTP against Shopify. */
export function isShopifyNetworkMode(): boolean {
  return !isShopifyBillingMock();
}

/**
 * Whether a workspace may be billed by Shopify AND by GOTCHA at the same time.
 *
 * Default false, and it must stay false until Shopify answers. Getting this
 * wrong in the permissive direction bills a merchant twice for one capability;
 * getting it wrong in the restrictive direction only shows them a
 * billing-pending screen.
 */
export function shopifyAllowSplitBilling(): boolean {
  return flag(process.env.SHOPIFY_ALLOW_SPLIT_BILLING, false);
}

/**
 * Whether the resolver may reach GRANDFATHERED_EXTERNAL at all.
 *
 * Off by default. Grandfathering is the one decision that hands somebody
 * ongoing access on the strength of claims about the past, so it needs an
 * explicit switch as well as explicit evidence.
 */
export function shopifyAllowGrandfathered(): boolean {
  return flag(process.env.SHOPIFY_ALLOW_GRANDFATHERED, false);
}

/** Whether metered usage may be dispatched to Shopify. */
export function shopifyUsageBillingEnabled(): boolean {
  return shopifyBillingEnabled() && flag(process.env.SHOPIFY_USAGE_BILLING_ENABLED, false);
}

/**
 * The configured policy mode, or null when none is set.
 *
 * Null is not a default-to-something: it means the resolver must answer
 * UNRESOLVED and land the merchant on a non-charging billing-pending screen.
 */
export function shopifyPolicyMode(): ShopifyPolicyMode | null {
  const raw = String(process.env.SHOPIFY_BILLING_POLICY_MODE || "").toLowerCase().trim();
  if (raw === "full") return "full";
  if (raw === "connector_addon") return "connector_addon";
  if (raw === "grandfathered_only") return "grandfathered_only";
  return null;
}

/** The app handle used to build Shopify's hosted plan-selection URL. */
export function shopifyAppHandle(): string | null {
  return process.env.SHOPIFY_APP_HANDLE?.trim() || null;
}

/**
 * The moment the App Store listing went live.
 *
 * This is the line grandfathering is measured against: a workspace that was
 * already paying GOTCHA before it may keep paying only GOTCHA. It is
 * CONFIGURATION rather than a constant because the publication date is not
 * known while this is being built, and a placeholder compiled into the binary
 * would be a wrong answer that looks like a right one.
 *
 * Null - unset, or unparseable - means no cutoff has been declared, and
 * therefore that NOBODY is automatically eligible. That is the fail-closed
 * direction: the failure mode of a missing cutoff must be "nobody is
 * grandfathered by accident", never "everybody is".
 */
export function shopifyPublicationCutoff(): Date | null {
  const raw = process.env.SHOPIFY_APP_PUBLICATION_CUTOFF?.trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Whether a development or test store may be grandfathered automatically.
 *
 * Off by default. A development store has no commercial history to be
 * grandfathered ON, so an automatic grant there is always an artefact of
 * testing rather than a real entitlement - and one that would then look
 * identical to a real one in the grants table. Switching this on is how a
 * test environment opts in deliberately.
 */
export function shopifyGrandfatherDevStores(): boolean {
  return flag(process.env.SHOPIFY_GRANDFATHER_DEV_STORES, false);
}

// ─── Test-shop allowlist ──────────────────────────────────────────────────

/**
 * The stores permitted to enter the Shopify App Pricing flow while
 * `SHOPIFY_BILLING_ENV=test`.
 *
 * WHY THIS EXISTS
 * ---------------
 * Testing happens against the PRODUCTION Partner app, on the production host,
 * beside real merchants. `test` is not an isolated environment - it is the same
 * deployment with a flag flipped, and Shopify's $0-on-development-stores rule is
 * the only thing separating a test charge from a real one.
 *
 * Without an allowlist, flipping that flag would put every connected store into
 * the plan-selection flow at once: real merchants redirected to a Shopify
 * pricing page they never asked for, during a window meant to exercise one dev
 * store. That is not a billing bug so much as an incident.
 *
 * So in test mode the flow is opt-IN, per store, from server configuration.
 *
 * FAIL-CLOSED, IN THE ONLY DIRECTION THAT IS SAFE
 * -----------------------------------------------
 * An empty or missing list allows NOBODY. The failure mode of a forgotten
 * variable has to be "the test does not start", never "every merchant is
 * enrolled".
 *
 * NOT CONSULTED IN LIVE
 * ---------------------
 * `live` is the state where everyone is meant to participate. Letting an
 * allowlist survive into it would mean a stale test list silently excluding
 * paying merchants from billing - the same class of bug, pointing the other
 * way. `shopifyBillingAppliesToShop` returns true for every shop in `live` and
 * in `mock` without reading this at all.
 */
function normalizeAllowlistEntry(raw: string): string | null {
  let v = raw.trim().toLowerCase();
  if (!v) return null;

  // Operators paste what they have: a bare handle, a domain, sometimes a URL
  // copied out of the browser. Scheme and path are stripped; nothing else is
  // repaired.
  v = v.replace(/^https?:\/\//, "");
  v = v.split("/")[0];
  v = v.replace(/\.$/, "");
  if (!v) return null;

  // A bare handle is completed. A DOTTED host is not: completing `evil.com`
  // into `evil.com.myshopify.com` would turn a rejected entry into an
  // accepted-looking one, which is exactly the hazard the strict validator
  // exists to remove.
  const candidate = v.includes(".") ? v : `${v}.myshopify.com`;
  return strictShopDomain(candidate);
}

/**
 * The parsed allowlist. Separated by comma, whitespace or newline.
 *
 * Invalid entries are dropped rather than throwing, and reported separately at
 * boot: one typo must not take the whole list - and therefore the whole test -
 * with it, and a silently shorter list is safer than a silently longer one.
 */
export function shopifyBillingTestShops(): string[] {
  const raw = process.env.SHOPIFY_BILLING_TEST_SHOPS;
  if (!raw || !raw.trim()) return [];
  const out = new Set<string>();
  for (const part of raw.split(/[\s,]+/)) {
    const shop = normalizeAllowlistEntry(part);
    if (shop) out.add(shop);
  }
  return [...out];
}

/** Entries that could not be parsed. Names the input so a typo is findable. */
export function invalidTestShopEntries(): string[] {
  const raw = process.env.SHOPIFY_BILLING_TEST_SHOPS;
  if (!raw || !raw.trim()) return [];
  return raw
    .split(/[\s,]+/)
    .filter((p) => p.trim() && !normalizeAllowlistEntry(p));
}

/**
 * May this store enter the Shopify billing flow?
 *
 * The shop MUST already have been established by a verified path - the HMAC on
 * a Shopify request, or a stored `CommerceConnection`. This function is a
 * filter over an identity somebody else proved; it does not establish one, and
 * a caller passing a value that came from a query parameter or a request body
 * would be defeating the allowlist rather than using it.
 */
export function shopifyBillingAppliesToShop(shopDomain: string | null | undefined): boolean {
  // Only `test` is gated. `live` means everybody, and `mock` reaches nothing.
  if (shopifyBillingEnv() !== "test") return true;

  const shop = strictShopDomain(shopDomain);
  // An unparseable domain is not on any list. A malicious suffix
  // (`acme.myshopify.com.evil.com`) dies here rather than in the comparison.
  if (!shop) return false;

  return shopifyBillingTestShops().includes(shop);
}

/** Same reasoning as `flag`: the caller passes the value so the name stays literal. */
function jsonMap(raw: string | undefined): Record<string, string> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && v.trim()) out[k] = v.trim();
    }
    return out;
  } catch {
    // Deliberately not a throw at read time - assertShopifyBillingConfig() is
    // where a malformed map stops the service, so the failure lands at boot
    // rather than at one merchant's plan selection.
    return {};
  }
}

/** productKey -> Shopify plan handle. Configuration; never a price. */
export function shopifyPlanHandles(): Record<string, string> {
  return jsonMap(process.env.SHOPIFY_BILLING_PLAN_HANDLES);
}

/** internal metric -> Shopify usage meter handle. Case-sensitive at Shopify. */
export function shopifyUsageMeterHandles(): Record<string, string> {
  return jsonMap(process.env.SHOPIFY_USAGE_METER_HANDLES);
}

/**
 * Shopify's hosted plan-selection page for one store.
 *
 * `storeHandle` is the myshopify subdomain without the suffix - Shopify's URL
 * wants the handle, not the full domain.
 *
 * Returns null rather than a half-built URL when the app handle is not
 * configured. A redirect to a malformed admin URL would strand the merchant on
 * a Shopify 404 with no way back.
 */
export function shopifyPlanSelectionUrl(storeHandle: string): string | null {
  const app = shopifyAppHandle();
  const store = (storeHandle || "").trim().replace(/\.myshopify\.com$/i, "");
  if (!app || !store) return null;
  return `https://admin.shopify.com/store/${encodeURIComponent(store)}/charges/${encodeURIComponent(app)}/pricing_plans`;
}

export class ShopifyBillingConfigError extends Error {
  readonly code = "SHOPIFY_BILLING_CONFIG_INVALID";
  constructor(message: string) {
    super(`[shopify-billing] ${message}`);
    this.name = "ShopifyBillingConfigError";
  }
}

/**
 * Refuse to start on a configuration that would fail confusingly later.
 *
 * Called at boot alongside assertIcountConfig(). Deliberately permissive about
 * being switched OFF - a disabled integration needs no configuration at all -
 * and strict about being switched ON with something missing, because a Shopify
 * billing path that is enabled but cannot verify a subscription would accept
 * merchants and then be unable to tell whether any of them paid.
 */
export function assertShopifyBillingConfig(): void {
  if (!shopifyBillingEnabled()) return;

  const mode = shopifyBillingMode();
  if (mode === "disabled") {
    // A hard early throw: nothing below is meaningful without a mode, and
    // reporting "your catalog is empty" to somebody who has not chosen a
    // billing mechanism would be noise on top of the real problem.
    throw new ShopifyBillingConfigError(
      `SHOPIFY_BILLING_ENABLED is true but SHOPIFY_BILLING_MODE is "${process.env.SHOPIFY_BILLING_MODE ?? ""}". ` +
        `Expected "app_pricing" or "manual". Refusing to start rather than picking one.`,
    );
  }

  // Everything after this point ACCUMULATES.
  //
  // First-problem-wins turns configuring a deployment into a guessing game
  // played one restart at a time: fix the token, restart, learn the org id is
  // also missing, restart, learn the app id is missing. An operator should see
  // the whole list once.
  const problems: string[] = [];

  for (const [name, raw] of [
    ["SHOPIFY_BILLING_PLAN_HANDLES", process.env.SHOPIFY_BILLING_PLAN_HANDLES],
    ["SHOPIFY_USAGE_METER_HANDLES", process.env.SHOPIFY_USAGE_METER_HANDLES],
  ] as const) {
    if (raw && raw.trim()) {
      try {
        JSON.parse(raw);
      } catch {
        problems.push(`${name} is not valid JSON.`);
      }
    }
  }

  problems.push(...validatePlanCatalog());

  if (mode === "app_pricing") {
    if (!shopifyAppHandle()) {
      problems.push(
        "SHOPIFY_APP_HANDLE is required for app_pricing: without it there is no plan-selection URL to send a merchant to.",
      );
    }

    // Required in EVERY environment, mock included. Without a catalog a
    // merchant can approve a charge this deployment cannot interpret, and
    // would then be billed without receiving access - the UNKNOWN_PLAN path.
    // Refusing to boot is a much better place for that to surface than a
    // support ticket from somebody already charged.
    if (sellablePlans().length === 0) {
      problems.push(
        "SHOPIFY_BILLING_PLAN_CATALOG defines no sellable plan (an entry needs a `key` AND a `handle`, and must " +
          "not be disabled), but SHOPIFY_BILLING_MODE=app_pricing. A merchant could approve a charge this " +
          "deployment cannot identify, and would be billed without receiving access.",
      );
    }
  }

  if (isShopifyNetworkMode()) {
    // Only checked in a networked environment. A mock stack legitimately has
    // no credentials, and demanding them would make local development need
    // production secrets to boot. That exemption is safe ONLY because mock
    // performs no network call and can neither create nor verify a real
    // subscription - `isShopifyBillingMock()` short-circuits every client.
    if (mode === "app_pricing") {
      // All three together. Checking only the token would let a deployment
      // boot happily and fail at the first verification, which is the moment
      // least convenient to discover it.
      const missing = (
        [
          ["SHOPIFY_PARTNER_API_TOKEN", process.env.SHOPIFY_PARTNER_API_TOKEN],
          ["SHOPIFY_PARTNER_ORGANIZATION_ID", process.env.SHOPIFY_PARTNER_ORGANIZATION_ID],
          ["SHOPIFY_PARTNER_APP_ID", process.env.SHOPIFY_PARTNER_APP_ID],
        ] as const
      )
        .filter(([, v]) => !v || !String(v).trim())
        .map(([name]) => name);

      if (missing.length > 0) {
        // Names only, never a value. The token is exactly the thing a boot log
        // would be a bad place to leak.
        problems.push(
          `app_pricing verifies subscriptions through the Partner API, so ${missing.join(", ")} ` +
            `${missing.length === 1 ? "is" : "are"} required in env="${shopifyBillingEnv()}". ` +
            "Shopify App Pricing sends no subscription webhooks, so without these there is no way to learn " +
            "that anybody paid.",
        );
      }
    }

    if (shopifyUsageBillingEnabled() && !process.env.SHOPIFY_APP_EVENTS_CLIENT_ID) {
      problems.push(
        "SHOPIFY_USAGE_BILLING_ENABLED is true but SHOPIFY_APP_EVENTS_CLIENT_ID is unset - usage could be " +
          "recorded and never billed, silently.",
      );
    }
  }

  if (problems.length > 0) {
    throw new ShopifyBillingConfigError(problems.join(" "));
  }
}

/**
 * One-line boot report. Logs what is on, never what the credentials are.
 */
export function reportShopifyBillingConfig(): void {
  if (!shopifyBillingEnabled()) {
    console.log("[shopify-billing] disabled (SHOPIFY_BILLING_ENABLED is not true)");
    return;
  }
  console.log(
    `[shopify-billing] mode=${shopifyBillingMode()} env=${shopifyBillingEnv()} ` +
      `policy=${shopifyPolicyMode() ?? "unresolved"} split=${shopifyAllowSplitBilling()} ` +
      `grandfathered=${shopifyAllowGrandfathered()} usage=${shopifyUsageBillingEnabled()} ` +
      // COUNT, never the domains. A shop domain identifies a customer, and this
      // line sits in the same boot log as configuration that is adjacent to
      // secrets. The list itself is readable from the environment by anyone who
      // needs it.
      `testShops=${shopifyBillingEnv() === "test" ? shopifyBillingTestShops().length : "n/a"}`,
  );

  if (shopifyBillingEnv() === "test" && shopifyBillingMode() === "app_pricing") {
    const allowed = shopifyBillingTestShops().length;
    if (allowed === 0) {
      console.warn(
        "[shopify-billing] env=test with an EMPTY SHOPIFY_BILLING_TEST_SHOPS: no store may enter the " +
          "App Pricing flow. This is the safe default, not a failure - set the variable to opt a " +
          "development store in.",
      );
    }
    const bad = invalidTestShopEntries();
    if (bad.length > 0) {
      console.warn(
        `[shopify-billing] SHOPIFY_BILLING_TEST_SHOPS has ${bad.length} unparseable entr` +
          `${bad.length === 1 ? "y" : "ies"} which will be ignored: ${bad.join(", ")}. ` +
          "Expected a myshopify handle or domain.",
      );
    }
  }
}
