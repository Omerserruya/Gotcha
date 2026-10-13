/**
 * ONE interpretation of the Shopify Connector's state, for every screen.
 *
 * WHY THIS IS A MODULE AND NOT LOGIC INSIDE A COMPONENT
 * -----------------------------------------------------
 * The Billing page and the Shopify integration page must never disagree about
 * whether Shopify is active. Two components each reading the snapshot and each
 * deciding what it means is how a merchant is told "connected" on one screen
 * and "billing required" on the other, and it is the kind of contradiction an
 * App Store reviewer is specifically looking for. Both screens import this.
 *
 * NOTHING HERE DECIDES AUTHORIZATION.
 * The server computed it from a verified read of Shopify. This function only
 * chooses words. In particular `grantsAccess` is copied from the snapshot and
 * never recomputed: a frontend that re-derived it could show Shopify features
 * as available on evidence the backend rejected.
 *
 * WHAT MUST NEVER REACH THIS FUNCTION
 * A query parameter, a browser flag, a Core plan key, the presence of Shopify
 * credentials, or the fact that OAuth finished. Installation and payment are
 * independent facts: a store can be fully installed and completely unpaid, and
 * saying "connected" on the strength of OAuth is exactly the claim requirement
 * 1.2.1 asks us not to make. The only input is the server snapshot.
 */
import type { ShopifyBillingSnapshot } from "@/lib/api";

/** Stable identifiers - safe to assert on in tests and to key translations. */
export type ConnectorStateKey =
  | "notActive"
  | "notConnected"
  | "billingRequired"
  | "approvalPending"
  | "active"
  | "trialing"
  | "pastDue"
  | "frozen"
  | "cancelled"
  | "unknownPlan"
  | "grandfathered"
  | "unavailable";

export type ConnectorTone = "ok" | "warn" | "info" | "neutral";

/**
 * What the button does, if there is one.
 *
 * `manage` and `choosePlan` both open the SERVER-supplied Shopify page; they
 * differ only in what the label promises. Neither may imply that pressing it
 * grants access - Shopify decides that, and we find out by verifying
 * afterwards. `retry` re-reads our own state and exists so that a state we
 * genuinely cannot resolve is not a dead end.
 */
export type ConnectorAction = "none" | "choosePlan" | "manage" | "retry";

export interface ConnectorPresentation {
  key: ConnectorStateKey;
  tone: ConnectorTone;
  /** i18n keys, so one mapping serves English and Hebrew alike. */
  titleKey: string;
  bodyKey: string;
  action: ConnectorAction;
  /** Show the "contact support" line beneath the state. */
  support?: boolean;
  /**
   * Whether Shopify data and actions are actually switched on. Copied from the
   * server verdict, never inferred from installation or plan.
   */
  grantsAccess: boolean;
  /** Interpolation values the copy may reference. */
  vars: Record<string, string>;
}

const K = "settings.billing.shopifyConnector.state";

export interface PresentOptions {
  /**
   * Keep the section on screen even when Shopify billing is UNRESOLVED for this
   * deployment.
   *
   * The Billing page passes this and the integration banner does not, and the
   * difference is not cosmetic. On the Billing page the reviewer is looking at
   * externally billed GOTCHA plans; if the Connector vanishes, the only thing
   * left to read is "here are GOTCHA's plans", and the honest conclusion from
   * that page alone is that Shopify functionality comes with them. That is the
   * 1.2.1 finding, recreated by an empty state.
   *
   * On the integration screen the connection card already speaks and a strip
   * about a subscription that cannot exist yet is noise, so it stays hidden.
   *
   * It is an OPTION rather than a second mapping so both screens keep reading
   * one interpretation of one snapshot.
   */
  alwaysShow?: boolean;
}

/**
 * Turn the server snapshot into what to show.
 *
 * `null` means render nothing at all. Without `alwaysShow`, an UNRESOLVED
 * deployment is one of those cases: Shopify billing is switched off and there
 * is no honest statement to make about a subscription that cannot exist.
 */
export function presentConnector(
  snapshot: ShopifyBillingSnapshot | null,
  options: PresentOptions = {},
): ConnectorPresentation | null {
  if (!snapshot) return null;

  const grantsAccess = snapshot.grantsAccess === true;
  const shop = snapshot.installation?.shopDomain ?? "";
  const vars: Record<string, string> = { shop };

  // No store at all. Checked BEFORE the billing state because a workspace that
  // never installed the app has no subscription question to answer, and
  // "choose a plan" would be a confusing thing to say to them.
  const installed = !!(snapshot.installation?.connectionId || snapshot.installation?.shopDomain);
  const uninstalled = !!snapshot.installation?.uninstalledAt;
  if (!installed || uninstalled) {
    return {
      key: "notConnected",
      tone: "neutral",
      titleKey: `${K}.notConnected.title`,
      bodyKey: `${K}.notConnected.body`,
      action: "none",
      grantsAccess: false,
      vars,
    };
  }

  // Every destination is the SERVER's. The frontend has no code path that can
  // build a Shopify URL, because one built here could address a store this
  // workspace does not own. With no destination we offer a retry instead of a
  // button that goes nowhere.
  const hasUrl = !!snapshot.planSelectionUrl;
  const manage: ConnectorAction = hasUrl ? "manage" : "retry";
  const choose: ConnectorAction = hasUrl ? "choosePlan" : "retry";

  const state = snapshot.shopify?.state;

  switch (state) {
    // Shopify billing is off or unconfigured for this deployment.
    //
    // On the integration screen there is nothing to say. On the Billing page
    // there is something important to say - that the Connector is a separate
    // subscription Shopify bills - and saying it does not require a
    // subscription to exist. It is NOT an error: a workspace that never
    // installed the app has done nothing wrong.
    case "UNRESOLVED":
      if (!options.alwaysShow) return null;
      return {
        key: "notActive",
        tone: "neutral",
        titleKey: `${K}.notActive.title`,
        bodyKey: `${K}.notActive.body`,
        action: "none",
        grantsAccess: false,
        vars,
      };

    case "NOT_REQUIRED_GRANDFATHERED":
      return {
        key: "grandfathered",
        tone: "ok",
        titleKey: `${K}.grandfathered.title`,
        bodyKey: `${K}.grandfathered.body`,
        // No Shopify subscription to manage: this access is not billed there.
        action: "none",
        grantsAccess,
        vars,
      };

    case "ACTIVE":
      return {
        key: "active",
        tone: "ok",
        titleKey: `${K}.active.title`,
        bodyKey: snapshot.shopify.cancelAtPeriodEnd
          ? `${K}.active.bodyEnding`
          : `${K}.active.body`,
        action: hasUrl ? "manage" : "none",
        grantsAccess,
        vars,
      };

    case "TRIALING":
      return {
        key: "trialing",
        tone: "ok",
        titleKey: `${K}.trialing.title`,
        bodyKey: `${K}.trialing.body`,
        action: hasUrl ? "manage" : "none",
        grantsAccess,
        vars,
      };

    // OAuth is done and nobody has paid. This is the state the reviewer will
    // see for most of the review, so it says plainly what is missing and where
    // to go - and it is NOT called "connected".
    case "PLAN_SELECTION_REQUIRED":
      return {
        key: "billingRequired",
        tone: "warn",
        titleKey: snapshot.shopify.declined
          ? `${K}.billingRequired.titleDeclined`
          : `${K}.billingRequired.title`,
        bodyKey: snapshot.shopify.declined
          ? `${K}.billingRequired.bodyDeclined`
          : `${K}.billingRequired.body`,
        action: choose,
        grantsAccess,
        vars,
      };

    case "APPROVAL_PENDING":
      return {
        key: "approvalPending",
        tone: "warn",
        titleKey: `${K}.approvalPending.title`,
        bodyKey: `${K}.approvalPending.body`,
        action: manage,
        grantsAccess,
        vars,
      };

    case "PAST_DUE":
      return {
        key: "pastDue",
        tone: "warn",
        titleKey: `${K}.pastDue.title`,
        bodyKey: `${K}.pastDue.body`,
        // Settling the charge happens in Shopify, so send them there rather
        // than leaving a status they can do nothing about.
        action: manage,
        grantsAccess,
        vars,
      };

    case "FROZEN":
      return {
        key: "frozen",
        tone: "warn",
        titleKey: `${K}.frozen.title`,
        bodyKey: `${K}.frozen.body`,
        action: manage,
        grantsAccess,
        vars,
      };

    case "CANCELLED":
      return {
        key: "cancelled",
        tone: "warn",
        titleKey: `${K}.cancelled.title`,
        bodyKey: `${K}.cancelled.body`,
        action: choose,
        grantsAccess,
        vars,
      };

    // OUR configuration is incomplete, not theirs. The merchant IS paying
    // Shopify, so "choose a plan" would ask them to pay twice.
    //
    // The two bodies are NOT cosmetic. `grantsAccess` is the server's verdict
    // and the copy follows it exactly: when it is false nothing was switched on
    // and "finishing your setup" would be a false reassurance; when it is true,
    // access the merchant already had is being held open while we fix the
    // catalog - a different promise, and still not a claim that setup worked.
    //
    // The unknown plan handle is NOT shown. It is configuration rather than a
    // credential, so it is safe, but it means nothing to a merchant and support
    // can read it from the snapshot.
    case "UNKNOWN_PLAN":
      return {
        key: "unknownPlan",
        tone: "warn",
        titleKey: `${K}.unknownPlan.title`,
        bodyKey: grantsAccess ? `${K}.unknownPlan.bodyPreserved` : `${K}.unknownPlan.body`,
        action: hasUrl ? "manage" : "none",
        support: true,
        grantsAccess,
        vars,
      };

    case "ERROR":
    default:
      return {
        key: "unavailable",
        tone: "info",
        titleKey: `${K}.unavailable.title`,
        bodyKey: `${K}.unavailable.body`,
        // We could not resolve our own state: offer a retry and a support path
        // rather than a status the merchant can only stare at.
        action: "retry",
        support: true,
        grantsAccess,
        vars,
      };
  }
}

/** The Shopify capabilities the Connector unlocks, as i18n keys. */
export const CONNECTOR_CAPABILITY_KEYS = [
  "settings.billing.shopifyConnector.capabilities.store",
  "settings.billing.shopifyConnector.capabilities.catalog",
  "settings.billing.shopifyConnector.capabilities.orders",
  "settings.billing.shopifyConnector.capabilities.actions",
  "settings.billing.shopifyConnector.capabilities.storefront",
] as const;

/**
 * What the SHOPIFY INTEGRATION screens may claim.
 *
 * WHY THIS EXISTS BESIDE `presentConnector`
 * -----------------------------------------
 * `presentConnector` answers "what should the Connector banner say". It was
 * correct, and the banner was correct, and the page around it still announced
 * Shopify as active: the integration screens each computed their own
 * `isConnected` from `TenantIntegration.status`, which records only that OAuth
 * finished. So one page showed "Connector required" beside a green "Active"
 * store, an enabled system toggle, writeback on, and 68 of 68 Shopify tools
 * live. That is precisely the contradiction App Store requirement 1.2.1 is
 * about: the merchant was told the paid feature was off and shown it running.
 *
 * INSTALLATION AND PAID ACCESS ARE DIFFERENT FACTS.
 * OAuth says the merchant let us in. The Connector subscription says Shopify is
 * being paid for. A store can be fully, healthily installed and completely
 * unpaid, and in that state every Shopify-specific feature indicator must read
 * off, while the installation itself stays untouched - we do not drop an OAuth
 * grant because a subscription lapsed.
 *
 * `grantsAccess` is copied from the server verdict and never recomputed here,
 * for the same reason it is never recomputed in `presentConnector`.
 */
export interface ShopifyFeatureAccess {
  /**
   * This gate has something to say. False for every non-Shopify integration,
   * and false when the deployment has no snapshot at all - in both cases the
   * screens keep their existing behaviour untouched.
   */
  applies: boolean;
  /** OAuth completed and the installation has not been removed. */
  authorized: boolean;
  /**
   * The paid Connector is verified. THE ONLY INPUT any Shopify feature claim
   * may derive from.
   */
  grantsAccess: boolean;
  /**
   * What to call the installation. Never "Active" without payment: an
   * authorized store that has not paid is exactly "Authorized".
   */
  installationLabelKey: string;
  /** Put "Connector required" beside the store name. */
  showConnectorRequired: boolean;
  /**
   * Whether Shopify-specific features may be presented as on: the system
   * toggle, writeback, the tool list, the capability chips. One flag so a new
   * indicator cannot be added that forgets to ask.
   */
  featuresEnabled: boolean;
  /**
   * We asked Shopify to uninstall and are waiting for its verified webhook.
   *
   * The store is STILL CONNECTED in this state and its data still works, so
   * this is not a kind of disconnection - it is a request in flight. Screens
   * use it to say "waiting", to stop a second disconnect being started, and
   * above all to avoid showing "Disconnected" for something Shopify has not
   * confirmed.
   */
  awaitingUninstall: boolean;
}

const FK = "marketplace.shopifyAccess";

/**
 * Decide what a Shopify integration surface may claim.
 *
 * `slug` is taken rather than assumed so a caller cannot accidentally apply the
 * Shopify gate to Airtable; `applies` is false for everything else and the
 * caller's existing logic stands.
 */
export function presentShopifyFeatureAccess(
  slug: string,
  snapshot: ShopifyBillingSnapshot | null,
  opts: { integrationConnected: boolean; awaitingUninstall?: boolean },
): ShopifyFeatureAccess {
  // `grantsAccess` answers "is it paid", which is not the same question as "is
  // it connected". A merchant who disconnects Shopify inside GOTCHA has removed
  // the credentials; whether a subscription is still live somewhere does not
  // make the features work, and showing them as on would be the same false
  // claim from the other direction. So a disconnected integration closes the
  // gate no matter what billing says.
  if (slug === "shopify" && !opts.integrationConnected) {
    return {
      applies: true,
      authorized: false,
      grantsAccess: false,
      installationLabelKey: `${FK}.disconnected`,
      showConnectorRequired: false,
      featuresEnabled: false,
      awaitingUninstall: false,
    };
  }
  const neutral: ShopifyFeatureAccess = {
    applies: false,
    authorized: opts.integrationConnected,
    grantsAccess: true,
    installationLabelKey: `${FK}.active`,
    showConnectorRequired: false,
    // Non-Shopify integrations are not gated by a Shopify subscription.
    featuresEnabled: true,
    awaitingUninstall: false,
  };
  if (slug !== "shopify") return neutral;

  // No snapshot means Shopify billing is not resolved for this deployment. We
  // deliberately do NOT switch every indicator off on missing data: that would
  // break self-hosted and pre-billing installs which never had a Connector to
  // begin with. The banner already stays silent in that case for the same
  // reason, and this keeps the two consistent.
  if (!snapshot) return neutral;

  const grantsAccess = snapshot.grantsAccess === true;
  const authorized =
    opts.integrationConnected && !snapshot.installation?.uninstalledAt;

  return {
    applies: true,
    authorized,
    grantsAccess,
    // The whole point: authorized-but-unpaid reads "Authorized", never "Active".
    installationLabelKey: grantsAccess ? `${FK}.active` : `${FK}.authorized`,
    showConnectorRequired: authorized && !grantsAccess,
    featuresEnabled: grantsAccess,
    // Set by the caller, which is the only side that can see the connection
    // row's config. Defaulted false so a caller that does not know cannot
    // accidentally claim a transition is in flight.
    awaitingUninstall: opts.awaitingUninstall === true,
  };
}
