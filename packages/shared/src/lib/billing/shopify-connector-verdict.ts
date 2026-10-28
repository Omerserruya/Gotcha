/**
 * The Shopify Connector's ONE verdict: does this workspace have Shopify
 * access, which capabilities, and what to call its state on a screen.
 *
 * Pure, so billing's GET /api/billing/shopify/state and ai's integrations and
 * tool screens compute the same answer from the same rows. Shopify review
 * 132211 (1.2.1) rejected us twice; one reason was that "Connected" and an
 * action count were read from the OAuth row while billing said otherwise.
 *
 * ACCESS IS AN AND OF FOUR FACTS, each of which can be false on its own:
 *   1. installed: no uninstall recorded;
 *   2. the connection is live (CONNECTED, which billing writes only once a
 *      subscription entitles; OAuth alone is BILLING_PENDING);
 *   3. the billing state grants (ACTIVE, TRIALING, or the grandfather exemption);
 *   4. every entitlement the merchant's current catalog plan funds is present.
 *      An unknown plan cannot name what it funds, so it never grants.
 * A capability needs 1-3 and ITS OWN entitlement row: one entitlement never
 * opens another.
 *
 * "Authorized" (OAuth done) is never "active". GOTCHA Core is not an input:
 * a Core plan of any price grants nothing here.
 */
import { SHOPIFY_FUNDED_ENTITLEMENTS, type ShopifyCapability } from "./shopify-authorization";

/** Billing states that can grant, given the other three facts. */
const GRANTING_STATES: ReadonlySet<string> = new Set(["ACTIVE", "TRIALING", "NOT_REQUIRED_GRANDFATHERED"]);

export type ShopifyConnectorStatus =
  | "not_installed"
  | "authorized_not_active"
  | "approval_pending"
  | "active"
  | "trialing"
  | "past_due"
  | "frozen"
  | "cancelled"
  | "uninstall_pending"
  | "uninstalled"
  | "error";

export interface ShopifyConnectorVerdictInput {
  /** The billing state (ShopifyBillingState). */
  state: string;
  /** CommerceConnection.status, or null when there is no connection row. */
  installationStatus: string | null | undefined;
  uninstalledAt: Date | string | null | undefined;
  /** The in-product uninstall request waiting for Shopify's webhook. */
  uninstallRequestedAt?: Date | string | null;
  /** Shopify-funded entitlement keys the tenant holds. */
  entitlements: readonly string[];
  /** What the current catalog plan funds; null when the plan is unknown. */
  requiredEntitlements: readonly string[] | null;
}

export interface ShopifyConnectorVerdict {
  scope: "shopify_connector";
  billedBy: "shopify";
  grantsAccess: boolean;
  capabilities: Record<ShopifyCapability, boolean>;
  status: ShopifyConnectorStatus;
}

const STATUS_FOR_STATE: Record<string, ShopifyConnectorStatus> = {
  APPROVAL_PENDING: "approval_pending",
  PAST_DUE: "past_due",
  FROZEN: "frozen",
  CANCELLED: "cancelled",
  ERROR: "error",
  UNKNOWN_PLAN: "error",
};

export function shopifyConnectorVerdict(input: ShopifyConnectorVerdictInput): ShopifyConnectorVerdict {
  const held = new Set(input.entitlements ?? []);
  const installed = !!input.installationStatus && input.installationStatus !== "NONE" && !input.uninstalledAt;
  const live = installed && String(input.installationStatus).toUpperCase() === "CONNECTED";
  const granting = GRANTING_STATES.has(input.state);
  const base = installed && live && granting;
  const required = input.requiredEntitlements;
  const funded = !!required && required.length > 0 && required.every((k) => held.has(k));

  const capabilities = Object.fromEntries(
    SHOPIFY_FUNDED_ENTITLEMENTS.map((k) => [k, base && held.has(k)]),
  ) as Record<ShopifyCapability, boolean>;
  const grantsAccess = base && funded;

  let status: ShopifyConnectorStatus;
  if (!input.installationStatus || input.installationStatus === "NONE") status = "not_installed";
  else if (input.uninstalledAt) status = "uninstalled";
  else if (input.uninstallRequestedAt) status = "uninstall_pending";
  else if (grantsAccess) status = input.state === "TRIALING" ? "trialing" : "active";
  // Shopify says it is paid and we hold less than the plan funds: our drift,
  // shown as an error rather than as a merchant who has not subscribed.
  else if (granting && input.state !== "NOT_REQUIRED_GRANDFATHERED" && live) status = "error";
  else status = STATUS_FOR_STATE[input.state] ?? "authorized_not_active";

  return { scope: "shopify_connector", billedBy: "shopify", grantsAccess, capabilities, status };
}
