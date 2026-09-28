/**
 * The one answer to "may this workspace touch Shopify at all?".
 *
 * WHY THIS EXISTS AS ITS OWN MODULE
 * ---------------------------------
 * Shopify App Store requirement 1.2.1 says every paid capability tied to the
 * Shopify integration must be billed through Shopify. GOTCHA already bills the
 * Connector through Shopify App Pricing and already grants a precise set of
 * entitlements when that subscription is confirmed ACTIVE. What was missing was
 * the other half: nothing ever READ those entitlements. Three of the four
 * appeared exactly once in non-test code - in the list that grants them.
 *
 * A grant nobody checks is not an entitlement, it is a record. An active
 * Connector and a cancelled one produced identical access, which is precisely
 * what the reviewer could not verify.
 *
 * THE INVARIANT
 * -------------
 * Without an active Shopify Connector subscription, or a valid pre-publication
 * grandfather grant, no code path may read from, write to, synchronize with, or
 * render functionality through Shopify. The workspace keeps GOTCHA Core and
 * every non-Shopify integration; only the Shopify-shaped surface stops.
 *
 * WHAT DELIBERATELY DOES NOT SATISFY IT
 * -------------------------------------
 * A Core plan. A generic `paid` or `active` tenant status. A plan rank. A
 * catalog `defaultValue`. A seat count. An AI bundle. Account age. Having
 * completed OAuth. A return URL. Anything a user can type.
 *
 * This is the reason the check is written against `source` and not against the
 * merged entitlement view: `resolveEntitlements` flattens plan defaults,
 * volume options and tenant rows into ONE pool, so a Core PlanVersion that
 * happened to list `shopify_catalog_sync` would read as authorized there. Here
 * only rows that Shopify actually funded count, which makes the boundary a
 * property of who paid rather than of what a plan row says.
 *
 * GRANDFATHERING
 * --------------
 * `SHOPIFY_GRANDFATHERED` is honoured because Shopify confirmed the
 * pre-publication carve-out in writing (ticket 69897769). It is a real grant
 * written by the billing service after checking the publication cutoff - not a
 * flag, not a query parameter, and not something this module can infer. If the
 * row is absent, nobody is grandfathered.
 */
import { prisma } from "../prisma";

/**
 * Capabilities a Shopify subscription pays for.
 *
 * Mirrors SHOPIFY_FUNDED_ENTITLEMENTS in
 * services/billing/src/services/provider-subscription.service.ts, which is the
 * only writer. Kept here as the reader's copy because packages/shared must not
 * import from a service; `shopify-authorization.test.ts` asserts the two lists
 * agree, so they cannot drift silently.
 */
export const SHOPIFY_FUNDED_ENTITLEMENTS = [
  "shopify_catalog_sync",
  "shopify_order_read",
  "shopify_order_actions",
  "shopify_storefront_widget",
] as const;

export type ShopifyCapability = (typeof SHOPIFY_FUNDED_ENTITLEMENTS)[number];

/**
 * The only two funding sources that authorize Shopify.
 *
 * Both are written exclusively by the billing service after an authoritative
 * read from Shopify (or, for the grandfather grant, after an explicit cutoff
 * check). Every other EntitlementSource - PLAN_DEFAULT, VOLUME_OPTION, ADDON,
 * PROMO, TRIAL, BETA, OVERRIDE - is GOTCHA-side and must never unlock Shopify,
 * because none of them represents money that reached Shopify.
 */
export const SHOPIFY_FUNDING_SOURCES = ["SHOPIFY_SUBSCRIPTION", "SHOPIFY_GRANDFATHERED"] as const;

export type ShopifyDenialReason =
  | "no_shopify_funded_entitlement"
  | "capability_not_funded"
  | "entitlement_expired";

export interface ShopifyAuthorization {
  authorized: boolean;
  /** Which of the two funding sources granted it, for audit and for the UI. */
  source: (typeof SHOPIFY_FUNDING_SOURCES)[number] | null;
  /** Exactly the Shopify capabilities this workspace has paid for. */
  capabilities: ShopifyCapability[];
  reason: ShopifyDenialReason | null;
}

const DENIED: ShopifyAuthorization = {
  authorized: false,
  source: null,
  capabilities: [],
  reason: "no_shopify_funded_entitlement",
};

/** True when a stored entitlement value means "on". */
function isOn(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (value && typeof value === "object" && "value" in (value as any)) {
    return Boolean((value as any).value);
  }
  return Boolean(value);
}

/**
 * Read the workspace's Shopify authorization.
 *
 * Reads ONLY `tenant_entitlements`, and only rows whose `source` is one of the
 * two Shopify funding sources. It never touches the subscription, the plan, the
 * feature catalog or any default - so there is no path by which a Core purchase
 * can widen what this returns.
 *
 * Fails CLOSED. A database error propagates rather than resolving to "allowed":
 * an outage must not become free Shopify access, and the caller decides whether
 * to surface an error or degrade.
 */
export async function getShopifyAuthorization(tenantId: string): Promise<ShopifyAuthorization> {
  if (!tenantId) return DENIED;

  const rows = await prisma.tenantEntitlement.findMany({
    where: {
      tenantId,
      entitlementKey: { in: [...SHOPIFY_FUNDED_ENTITLEMENTS] },
      source: { in: [...SHOPIFY_FUNDING_SOURCES] as any },
    },
    select: { entitlementKey: true, value: true, source: true, expiresAt: true },
  });

  const now = new Date();
  const live = rows.filter((r) => isOn(r.value) && (!r.expiresAt || r.expiresAt > now));
  if (!live.length) {
    // Distinguish "never had it" from "had it and it lapsed", because the two
    // deserve different words in the UI and different follow-up.
    const expired = rows.some((r) => isOn(r.value) && r.expiresAt && r.expiresAt <= now);
    return { ...DENIED, reason: expired ? "entitlement_expired" : "no_shopify_funded_entitlement" };
  }

  // A subscription outranks a grandfather grant when both somehow exist: the
  // merchant is paying, and that is the more truthful thing to report.
  const source = live.some((r) => r.source === "SHOPIFY_SUBSCRIPTION")
    ? "SHOPIFY_SUBSCRIPTION"
    : "SHOPIFY_GRANDFATHERED";

  return {
    authorized: true,
    source,
    capabilities: live.map((r) => r.entitlementKey as ShopifyCapability),
    reason: null,
  };
}

/**
 * True when the workspace may reach Shopify at all.
 *
 * `capability` narrows it to one funded capability. Omitting it asks the
 * broader question - "is Shopify open for this workspace" - which is the right
 * one at the credential boundary, where the specific capability is not yet
 * known.
 */
export async function isShopifyAuthorized(
  tenantId: string,
  capability?: ShopifyCapability,
): Promise<boolean> {
  const auth = await getShopifyAuthorization(tenantId);
  if (!auth.authorized) return false;
  return capability ? auth.capabilities.includes(capability) : true;
}

/**
 * Thrown by `assertShopifyAuthorized`.
 *
 * Carries no token, no shop domain and no subscription id: this error is
 * rendered to merchants and written to logs, and the Shopify review explicitly
 * checks that credentials never appear in either.
 */
export class ShopifyConnectorRequiredError extends Error {
  readonly code = "SHOPIFY_CONNECTOR_REQUIRED";
  readonly status = 402;
  constructor(
    readonly capability: ShopifyCapability | null,
    readonly denialReason: ShopifyDenialReason,
  ) {
    super(
      "The Shopify Connector subscription is required for Shopify data and actions. " +
        "GOTCHA Core and non-Shopify integrations are unaffected.",
    );
    this.name = "ShopifyConnectorRequiredError";
  }
}

/** Throw unless the workspace is authorized for Shopify (optionally, for one capability). */
export async function assertShopifyAuthorized(
  tenantId: string,
  capability?: ShopifyCapability,
): Promise<ShopifyAuthorization> {
  const auth = await getShopifyAuthorization(tenantId);
  if (!auth.authorized) {
    throw new ShopifyConnectorRequiredError(capability ?? null, auth.reason ?? "no_shopify_funded_entitlement");
  }
  if (capability && !auth.capabilities.includes(capability)) {
    throw new ShopifyConnectorRequiredError(capability, "capability_not_funded");
  }
  return auth;
}
