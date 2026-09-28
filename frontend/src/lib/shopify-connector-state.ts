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

export interface ConnectorPresentation {
  key: ConnectorStateKey;
  tone: ConnectorTone;
  /** i18n keys, so one mapping serves English and Hebrew alike. */
  titleKey: string;
  bodyKey: string;
  /** Offer the button that sends the merchant to Shopify's hosted page. */
  action: boolean;
  /**
   * Whether Shopify data and actions are actually switched on. Copied from the
   * server verdict, never inferred from installation or plan.
   */
  grantsAccess: boolean;
  /** Interpolation values the copy may reference. */
  vars: Record<string, string>;
}

const K = "settings.billing.shopifyConnector.state";

/**
 * Turn the server snapshot into what to show.
 *
 * `null` means render nothing at all: Shopify billing is switched off for this
 * deployment and there is no honest statement to make about a subscription that
 * cannot exist. An empty card saying nothing is worse than no card.
 */
export function presentConnector(
  snapshot: ShopifyBillingSnapshot | null,
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
      action: false,
      grantsAccess: false,
      vars,
    };
  }

  const state = snapshot.shopify?.state;

  switch (state) {
    // Shopify billing is off for this deployment. Say nothing rather than
    // inventing a subscription state.
    case "UNRESOLVED":
      return null;

    case "NOT_REQUIRED_GRANDFATHERED":
      return {
        key: "grandfathered",
        tone: "ok",
        titleKey: `${K}.grandfathered.title`,
        bodyKey: `${K}.grandfathered.body`,
        action: false,
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
        action: false,
        grantsAccess,
        vars,
      };

    case "TRIALING":
      return {
        key: "trialing",
        tone: "ok",
        titleKey: `${K}.trialing.title`,
        bodyKey: `${K}.trialing.body`,
        action: false,
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
        action: !!snapshot.planSelectionUrl,
        grantsAccess,
        vars,
      };

    case "APPROVAL_PENDING":
      return {
        key: "approvalPending",
        tone: "warn",
        titleKey: `${K}.approvalPending.title`,
        bodyKey: `${K}.approvalPending.body`,
        action: !!snapshot.planSelectionUrl,
        grantsAccess,
        vars,
      };

    case "PAST_DUE":
      return {
        key: "pastDue",
        tone: "warn",
        titleKey: `${K}.pastDue.title`,
        bodyKey: `${K}.pastDue.body`,
        action: false,
        grantsAccess,
        vars,
      };

    case "FROZEN":
      return {
        key: "frozen",
        tone: "warn",
        titleKey: `${K}.frozen.title`,
        bodyKey: `${K}.frozen.body`,
        action: false,
        grantsAccess,
        vars,
      };

    case "CANCELLED":
      return {
        key: "cancelled",
        tone: "warn",
        titleKey: `${K}.cancelled.title`,
        bodyKey: `${K}.cancelled.body`,
        action: !!snapshot.planSelectionUrl,
        grantsAccess,
        vars,
      };

    // OUR configuration is incomplete, not theirs. The merchant IS paying
    // Shopify, so "choose a plan" would ask them to pay twice. The plan handle
    // is configuration, not a credential, and naming it is what makes this
    // actionable for an operator.
    case "UNKNOWN_PLAN":
      return {
        key: "unknownPlan",
        tone: "info",
        titleKey: `${K}.unknownPlan.title`,
        bodyKey: `${K}.unknownPlan.body`,
        action: false,
        grantsAccess,
        vars: { ...vars, handle: snapshot.shopify.unknownPlanHandle ?? "" },
      };

    case "ERROR":
    default:
      return {
        key: "unavailable",
        tone: "info",
        titleKey: `${K}.unavailable.title`,
        bodyKey: `${K}.unavailable.body`,
        action: false,
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
