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
