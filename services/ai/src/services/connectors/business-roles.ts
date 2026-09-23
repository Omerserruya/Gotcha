/**
 * Business core: which part of a business each integration can BE.
 *
 * Screen 14's model is a use case (ecommerce / leads / both), then one chosen
 * connection per part: ecommerce platform · payments · shipping · returns · CRM.
 *
 * ── Why this is code and not a column ──
 *
 * `DEFAULT_CAPABILITIES` in crm-adapter.types.ts sets the precedent: what a
 * vendor can truthfully do lives in the codebase, where it can be reviewed
 * against the adapter that has to honour it. A row somebody can edit into a lie
 * is worse, because the lie surfaces as a tool failing mid-conversation. Same
 * argument here, and it also means adding a role costs a diff rather than a
 * migration.
 *
 * ── The CRM role is READ, not restated ──
 *
 * `IntegrationCatalog.canActAsCrm` already decides which integrations may be
 * elected as the customer system of record, and it already drives the Settings
 * explorer. This map deliberately does NOT list `crm`: a second source for a
 * role that already has one is how the two drift apart. `rolesFor()` takes the
 * flag as an argument and adds `crm` itself.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * TWO THINGS THE CATALOGUE CANNOT ANSWER, REPORTED RATHER THAN PAPERED OVER
 *
 * 1 · `SHIPPING` is a real `IntegrationCategory` with ZERO integrations in it.
 *     No published row, none unpublished. So the shipping part's list is empty
 *     for every tenant, and `roleAvailability()` says so explicitly instead of
 *     returning an empty array that reads like "none connected yet".
 *
 * 2 · There is no RETURNS category at all, and `returngo` - a returns product -
 *     is filed under `ECOMMERCE`. So category alone would offer ReturnGo as an
 *     ecommerce PLATFORM beside Shopify and WooCommerce. That is precisely what
 *     this map is for: it says returngo serves `returns` and not `ecommerce`,
 *     and the disagreement with its stored category is deliberate and noted
 *     here rather than fixed silently in data.
 *
 * Both are decisions for the design, not gaps to close in code. A part whose
 * list can only ever be empty should not ship as a dropdown, and recategorising
 * returngo is a data change with a visible consequence.
 * ════════════════════════════════════════════════════════════════════════════
 */

/** The parts of a business this screen elects a system for. */
export const BUSINESS_ROLES = ["ecommerce", "payments", "shipping", "returns", "crm"] as const;
export type BusinessRole = (typeof BUSINESS_ROLES)[number];

/** What the business does, which decides which parts it is even asked about. */
export const USE_CASES = ["ecommerce", "leads", "both"] as const;
export type UseCase = (typeof USE_CASES)[number];

export function isUseCase(v: unknown): v is UseCase {
  return typeof v === "string" && (USE_CASES as readonly string[]).includes(v);
}

export function isBusinessRole(v: unknown): v is BusinessRole {
  return typeof v === "string" && (BUSINESS_ROLES as readonly string[]).includes(v);
}

/**
 * Which parts a use case needs a system for.
 *
 * A lead business is not asked about shipping or returns, and asking would be
 * the invented-gap bug the discovery engine already learned: nobody wants a
 * "return policy" prompt for a B2B pipeline.
 */
export const ROLES_FOR_USE_CASE: Record<UseCase, readonly BusinessRole[]> = {
  ecommerce: ["ecommerce", "payments", "shipping", "returns", "crm"],
  leads: ["crm"],
  both: ["ecommerce", "payments", "shipping", "returns", "crm"],
};

/**
 * The non-CRM roles each integration slug can truthfully serve.
 *
 * Keyed by catalogue slug. An integration absent from this map serves no
 * business-core part - `monday` and `google_calendar` are real integrations that
 * are simply not one of these five things, and listing them under a part to fill
 * it out would be the empty-dropdown problem solved dishonestly.
 */
export const ROLE_CAPABILITIES: Record<string, readonly BusinessRole[]> = {
  shopify: ["ecommerce"],
  woocommerce: ["ecommerce"],
  // Its category says ECOMMERCE. It is a returns product. See the header.
  returngo: ["returns"],
  stripe: ["payments"],
  paypal: ["payments"],
};

/**
 * Every role an integration can serve, given whether the catalogue permits it
 * as a customer system of record.
 *
 * `canActAsCrm` is passed in rather than looked up here so this stays a pure
 * function over data the caller already has, and so the CRM role keeps exactly
 * one source.
 */
export function rolesFor(slug: string, opts: { canActAsCrm: boolean; category?: string }): BusinessRole[] {
  const roles = [...(ROLE_CAPABILITIES[slug] ?? [])];
  // A dedicated CRM is a CRM by category; anything else needs the explicit flag.
  if (opts.canActAsCrm || opts.category === "CRM") roles.push("crm");
  return roles;
}

export type RoleAvailability =
  | { available: true }
  /** No integration in the catalogue can serve this part, for any tenant. */
  | { available: false; reason: "no_integrations_exist"; detail: string };

/**
 * Whether a part can be offered at all.
 *
 * Distinguished from "nothing connected yet" deliberately: those need different
 * sentences, and an empty list without a reason reads as the second when it is
 * the first. This is the null-versus-zero distinction for a dropdown.
 */
export function roleAvailability(role: BusinessRole): RoleAvailability {
  if (role === "shipping") {
    return {
      available: false,
      reason: "no_integrations_exist",
      detail:
        "No shipping integration exists in the catalogue yet, so there is nothing to choose. " +
        "The category is defined and empty.",
    };
  }
  return { available: true };
}

/**
 * Catalogue slugs that can serve a role, from the rows the caller read.
 *
 * Takes the catalogue as an argument: this module never queries, so it stays
 * unit-testable and the caller keeps one place that decides which rows are
 * visible to a tenant.
 */
export function candidatesForRole(
  role: BusinessRole,
  catalogue: ReadonlyArray<{ slug: string; canActAsCrm: boolean; category: string }>,
): string[] {
  return catalogue.filter((row) => rolesFor(row.slug, row).includes(role)).map((row) => row.slug);
}
