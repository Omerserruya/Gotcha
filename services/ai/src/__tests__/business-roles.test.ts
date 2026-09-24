/**
 * Which system can serve which part of a business.
 *
 * Screen 14 elects one connection per part: ecommerce platform, payments,
 * shipping, returns, CRM. Two things about the catalogue make that harder than
 * reading a category, and both are pinned here because both are facts a screen
 * would otherwise get wrong:
 *
 *   * `shipping` is a real category with ZERO integrations, so its list is empty
 *     for every tenant forever - which must not read as "nothing connected yet".
 *   * `returngo` is a RETURNS product stored under the ECOMMERCE category, so
 *     category alone would offer it as a storefront beside Shopify.
 */
import { describe, it, expect } from "vitest";
import {
  BUSINESS_ROLES,
  ROLES_FOR_USE_CASE,
  ROLE_CAPABILITIES,
  rolesFor,
  roleAvailability,
  candidatesForRole,
  isUseCase,
} from "../services/connectors/business-roles";

/** The published catalogue as it actually stands on this deployment. */
const CATALOGUE = [
  { slug: "shopify", canActAsCrm: true, category: "ECOMMERCE" },
  { slug: "woocommerce", canActAsCrm: false, category: "ECOMMERCE" },
  { slug: "returngo", canActAsCrm: false, category: "ECOMMERCE" },
  { slug: "stripe", canActAsCrm: false, category: "PAYMENTS" },
  { slug: "paypal", canActAsCrm: false, category: "PAYMENTS" },
  { slug: "hubspot", canActAsCrm: false, category: "CRM" },
  { slug: "salesforce", canActAsCrm: false, category: "CRM" },
  { slug: "zoho_crm", canActAsCrm: false, category: "CRM" },
  { slug: "fireberry", canActAsCrm: false, category: "CRM" },
  { slug: "airtable", canActAsCrm: true, category: "DATABASE" },
  { slug: "monday", canActAsCrm: false, category: "PROJECT_MANAGEMENT" },
  { slug: "google_calendar", canActAsCrm: false, category: "CALENDAR" },
];

describe("the CRM role has one source, and it is not this map", () => {
  it("never lists crm in the static map", () => {
    // canActAsCrm already decides this and already drives the Settings
    // explorer. A second source is how the two drift apart.
    for (const roles of Object.values(ROLE_CAPABILITIES)) {
      expect(roles).not.toContain("crm");
    }
  });

  it("grants crm from the catalogue flag", () => {
    expect(rolesFor("shopify", { canActAsCrm: true, category: "ECOMMERCE" })).toEqual(["ecommerce", "crm"]);
    expect(rolesFor("shopify", { canActAsCrm: false, category: "ECOMMERCE" })).toEqual(["ecommerce"]);
  });

  it("grants crm to a dedicated CRM by category, flag or not", () => {
    expect(rolesFor("hubspot", { canActAsCrm: false, category: "CRM" })).toEqual(["crm"]);
  });

  it("lets a database elected as the system of record serve crm", () => {
    // Airtable is category DATABASE with canActAsCrm true, which is exactly the
    // case the flag exists for.
    expect(rolesFor("airtable", { canActAsCrm: true, category: "DATABASE" })).toEqual(["crm"]);
  });
});

describe("the catalogue's two wrong answers", () => {
  it("★ lists ReturnGo under returns, NOT as an ecommerce platform", () => {
    const ecommerce = candidatesForRole("ecommerce", CATALOGUE);
    const returns = candidatesForRole("returns", CATALOGUE);

    // Its stored category says ECOMMERCE. Offering it as a storefront beside
    // Shopify is what reading the category alone would do.
    expect(ecommerce).toEqual(["shopify", "woocommerce"]);
    expect(returns).toEqual(["returngo"]);
  });

  it("★ says shipping cannot be offered at all, rather than returning an empty list", () => {
    const availability = roleAvailability("shipping");

    expect(availability.available).toBe(false);
    if (availability.available) return;
    expect(availability.reason).toBe("no_integrations_exist");
    // "Nothing exists to choose" and "nothing connected yet" need different
    // sentences, and an empty array reads as the second.
    expect(candidatesForRole("shipping", CATALOGUE)).toEqual([]);
  });

  it("every other part can be offered", () => {
    for (const role of BUSINESS_ROLES) {
      if (role === "shipping") continue;
      expect(roleAvailability(role).available).toBe(true);
      expect(candidatesForRole(role, CATALOGUE).length).toBeGreaterThan(0);
    }
  });
});

describe("integrations that serve no part of the business core", () => {
  it("does not press unrelated integrations into a role to fill the list", () => {
    // Monday and Google Calendar are real integrations that are simply not one
    // of these five things. Listing them would solve the empty-dropdown problem
    // dishonestly.
    expect(rolesFor("monday", { canActAsCrm: false, category: "PROJECT_MANAGEMENT" })).toEqual([]);
    expect(rolesFor("google_calendar", { canActAsCrm: false, category: "CALENDAR" })).toEqual([]);
  });

  it("an unknown slug serves nothing rather than defaulting into a role", () => {
    expect(rolesFor("something_new", { canActAsCrm: false, category: "CUSTOM" })).toEqual([]);
  });
});

describe("the use case decides which parts are asked about", () => {
  it("asks a lead business only about its CRM", () => {
    // No shipping or returns prompt for a B2B pipeline - the invented-gap bug
    // the discovery engine already learned.
    expect(ROLES_FOR_USE_CASE.leads).toEqual(["crm"]);
  });

  it("asks an ecommerce business about every part", () => {
    expect([...ROLES_FOR_USE_CASE.ecommerce]).toEqual([...BUSINESS_ROLES]);
    expect([...ROLES_FOR_USE_CASE.both]).toEqual([...BUSINESS_ROLES]);
  });

  it("accepts only the three use cases", () => {
    expect(isUseCase("ecommerce")).toBe(true);
    expect(isUseCase("leads")).toBe(true);
    expect(isUseCase("both")).toBe(true);
    // A scan's free-text guess is not a choice.
    expect(isUseCase("B2B SaaS")).toBe(false);
    expect(isUseCase(null)).toBe(false);
  });
});

/**
 * Electing a system for a part.
 *
 * ★ THE READ SIDE SHIPPED WITHOUT THIS WRITE, and that is the defect these cover.
 * `GET /business-core` reported who serves each part while nothing in the
 * monorepo ever wrote `config.roles` - so a five-part dropdown would have saved
 * for the CRM and silently done nothing for the other four. A control that looks
 * configurable and is not.
 *
 * Omer's ruling on conflict: it DISPLACES and the response names what it replaced.
 * Refusing would recreate the undeletable-employee trap - blocked by a state the
 * merchant cannot see - and silent displacement is the reassuring direction.
 */
import { planRoleElection, type ElectableIntegration } from "../services/connectors/business-roles";

const CONNECTED: ElectableIntegration[] = [
  { id: "ti_shopify", slug: "shopify", name: "Shopify", status: "CONNECTED", roles: [] },
  { id: "ti_woo", slug: "woocommerce", name: "WooCommerce", status: "CONNECTED", roles: ["ecommerce"] },
  { id: "ti_stripe", slug: "stripe", name: "Stripe", status: "CONNECTED", roles: ["payments"] },
];

describe("electing a system for a part", () => {
  it("elects an unheld part with a single write", () => {
    const plan = planRoleElection("returns", "shopify", [
      { id: "ti_rg", slug: "returngo", name: "ReturnGo", status: "CONNECTED", roles: [] },
      ...CONNECTED,
    ]);

    expect(plan.elected).toEqual({ slug: "shopify", name: "Shopify" });
    expect(plan.replaced).toBeNull();
    expect(plan.writes).toEqual([{ id: "ti_shopify", roles: ["returns"] }]);
  });

  it("★ DISPLACES the incumbent and names it", () => {
    const plan = planRoleElection("ecommerce", "shopify", CONNECTED);

    expect(plan.elected).toEqual({ slug: "shopify", name: "Shopify" });
    // The only way a screen can say "it was WooCommerce". Silent displacement is
    // the reassuring direction; refusing is the undeletable-employee trap.
    expect(plan.replaced).toEqual({ slug: "woocommerce", name: "WooCommerce" });
    expect(plan.writes).toEqual([
      { id: "ti_woo", roles: [] },
      { id: "ti_shopify", roles: ["ecommerce"] },
    ]);
  });

  it("leaves the incumbent's OTHER roles alone when displacing", () => {
    const withBoth: ElectableIntegration[] = [
      { id: "ti_shopify", slug: "shopify", name: "Shopify", status: "CONNECTED", roles: [] },
      { id: "ti_woo", slug: "woocommerce", name: "WooCommerce", status: "CONNECTED", roles: ["ecommerce", "payments"] },
    ];

    const plan = planRoleElection("ecommerce", "shopify", withBoth);

    // Losing one part must not clear the others.
    expect(plan.writes).toContainEqual({ id: "ti_woo", roles: ["payments"] });
  });

  it("re-electing the incumbent is a no-op, not a displace-then-add", () => {
    const plan = planRoleElection("ecommerce", "woocommerce", CONNECTED);

    expect(plan.replaced).toBeNull();
    // It already holds the part. Writing would churn the row for nothing, and
    // reporting itself as "replaced" would make the screen say it changed.
    expect(plan.writes).toEqual([]);
    expect(plan.elected).toEqual({ slug: "woocommerce", name: "WooCommerce" });
  });

  it("★ null CLEARS the part, which is a real answer", () => {
    const plan = planRoleElection("ecommerce", null, CONNECTED);

    // "Nothing serves this" is distinct from never having chosen, and the
    // incumbent is still named so the screen can say what was removed.
    expect(plan.elected).toBeNull();
    expect(plan.replaced).toEqual({ slug: "woocommerce", name: "WooCommerce" });
    expect(plan.writes).toEqual([{ id: "ti_woo", roles: [] }]);
  });

  it("clearing an unheld part changes nothing", () => {
    const plan = planRoleElection("returns", null, CONNECTED);

    expect(plan.writes).toEqual([]);
    expect(plan.replaced).toBeNull();
  });

  it("one system can serve several parts at once", () => {
    const plan = planRoleElection("crm", "shopify", [
      { id: "ti_shopify", slug: "shopify", name: "Shopify", status: "CONNECTED", roles: ["ecommerce"] },
    ]);

    // The route refuses `crm` for a different reason - one elector - but the RULE
    // must not assume a system holds at most one part.
    expect(plan.writes).toEqual([{ id: "ti_shopify", roles: ["ecommerce", "crm"] }]);
  });
});
