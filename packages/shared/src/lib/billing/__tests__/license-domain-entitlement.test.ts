/**
 * Two key namespaces, one guard, and the product it emptied.
 *
 * Reconstructed from the dev estate rather than imagined. Tenant "urban" was
 * on an ACTIVE plan whose entitlements say `ai: true`, `conversation: true`,
 * `channels: true` - 44 rows, all granted. Its materialized TenantFeature rows
 * said the opposite: every top-level domain false, every dotted sub-feature
 * true. The owner opened the workspace and most of the navigation was gone.
 *
 * The cause is that `isUnsellable` guarded ONE namespace while plans are
 * written in TWO. FEATURE_CATALOG holds dotted capabilities (`ai.copilot`).
 * The permission catalog holds the license keys a plan actually sells: the
 * domains (`ai`) and their colon sub-keys (`ai:employees`). Anything absent
 * from the first was called unsellable, so the domains were forced to false no
 * matter what the plan said - and `entitledIn` applies that BEFORE reading the
 * stored value, so the plan never got a vote.
 */
import { describe, it, expect } from "vitest";
import { isUnsellable, FEATURE_CATALOG } from "../feature-catalog";
import { entitledIn } from "../entitlement-resolver";
import { ALL_LICENSE_KEYS } from "../../permission-catalog";

/** A resolved set containing exactly the given BOOLEAN grants. */
function setWith(grants: Record<string, boolean>) {
  return {
    tenantId: "t",
    planKey: "ai_workforce",
    planVersion: 3,
    entries: new Map(
      Object.entries(grants).map(([key, bool]) => [
        key,
        { key, valueType: "BOOLEAN" as const, value: { bool }, source: "PLAN" as const },
      ]),
    ),
  } as any;
}

/** The top-level domains, e.g. "ai" - no colon, no dot. */
const DOMAINS = Array.from(new Set(ALL_LICENSE_KEYS.filter((k) => !k.includes(":")))).sort();

describe("license domains are sellable", () => {
  it("has domains to test, and they are absent from the feature catalog", () => {
    // If this ever fails the premise has changed and the rest is meaningless.
    expect(DOMAINS.length).toBeGreaterThan(3);
    const catalogKeys = new Set(FEATURE_CATALOG.map((f) => f.key));
    for (const d of DOMAINS) expect(catalogKeys.has(d), `${d} unexpectedly in FEATURE_CATALOG`).toBe(false);
  });

  it("no license domain is treated as unsellable", () => {
    for (const d of DOMAINS) expect(isUnsellable(d), `${d} must be sellable`).toBe(false);
  });

  it("a colon sub-key is sellable too", () => {
    const sub = ALL_LICENSE_KEYS.find((k) => k.includes(":"));
    expect(sub).toBeTruthy();
    expect(isUnsellable(sub!)).toBe(false);
  });

  it("a plan granting a domain actually grants it", () => {
    // The regression, stated directly: the plan said true and the tenant got
    // false, which is how a paid workspace ends up with an empty menu.
    for (const d of DOMAINS) {
      expect(entitledIn(setWith({ [d]: true }), d), `${d} granted by plan`).toBe(true);
    }
  });

  it("a plan denying a domain still denies it", () => {
    for (const d of DOMAINS) {
      expect(entitledIn(setWith({ [d]: false }), d), `${d} denied by plan`).toBe(false);
    }
  });
});

describe("the guard still does its job", () => {
  it("an unknown key remains unsellable", () => {
    // This is what the guard is FOR: a typo in a plan must not sell something
    // that does not exist. Loosening it into "unknown means allowed" would
    // have fixed the domains and quietly broken that.
    for (const bogus of ["ai.does_not_exist", "totally_made_up", "conversationn", ""]) {
      expect(isUnsellable(bogus), `${bogus} must stay unsellable`).toBe(true);
    }
  });

  it("a catalogued but unbuilt capability remains unsellable", () => {
    const unbuilt = FEATURE_CATALOG.find((f) => !f.implemented);
    if (!unbuilt) return; // nothing unbuilt right now; the rule still holds
    expect(isUnsellable(unbuilt.key)).toBe(true);
    // And no plan can override it - selling an unshipped feature is the one
    // thing this must refuse.
    expect(entitledIn(setWith({ [unbuilt.key]: true }), unbuilt.key)).toBe(false);
  });
});
