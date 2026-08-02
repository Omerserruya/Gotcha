import { describe, it, expect } from "vitest";
import { join } from "path";
import { execSync } from "child_process";
import { FEATURE_CATALOG, sellableFeatureKeys, getFeatureDef } from "../feature-catalog";
import { FEATURE_METADATA } from "../../features";
import { CORE_FEATURES } from "../plan-seeds";

/**
 * Makes `enforcementLocations` a contract instead of a comment.
 *
 * The 2026-07-31 audit found that field describing enforcement that did not
 * exist: `communication.crm_summaries` declared
 * "services/ai:post-conversation.summary", and all four post-conversation
 * services contained zero entitlement checks. Because ~20 features carry these
 * declarations, the field reads to any reviewer as an enforcement map. It was
 * not one.
 *
 * These tests fail if that drifts again — either the enforcement exists, or the
 * claim comes out of the catalog. Documentation that cannot be wrong is worth
 * more than documentation that is thorough.
 */

const REPO = join(__dirname, "..", "..", "..", "..", "..", "..");

/** Files referencing a literal key, excluding the files that DECLARE it. */
function refsToLiteral(key: string): string[] {
  try {
    const out = execSync(
      `grep -rl --include=*.ts -F '"${key}"' services packages/shared/src 2>/dev/null || true`,
      { cwd: REPO, encoding: "utf-8" },
    );
    return out.split("\n").filter(Boolean).filter((f) =>
      !f.includes("feature-catalog") &&
      !f.includes("plan-seeds") &&
      !f.includes("__tests__"),
    );
  } catch {
    return [];
  }
}

/**
 * Where a capability is actually enforced.
 *
 * A key can be gated two ways, and both are real:
 *   1. directly - some route or worker names the canonical key
 *   2. through the bridge - `materializesTo` names a legacy `lib/features.ts`
 *      key, `materializeEntitlements` writes that row, and the existing
 *      `requireFeature` gate reads it
 *
 * Counting only (1) would mark the bridged capabilities unenforced and push
 * the next person to bolt a second gate onto routes that already have one.
 */
function enforcementRefs(key: string): string[] {
  const direct = refsToLiteral(key);
  const legacy = getFeatureDef(key)?.materializesTo;
  return legacy ? [...direct, ...refsToLiteral(legacy)] : direct;
}

describe("every sellable capability is real", () => {
  it("has a unique key", () => {
    const keys = FEATURE_CATALOG.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("declares complete catalog metadata", () => {
    for (const f of FEATURE_CATALOG) {
      // Two legitimate key shapes: `domain.capability` and `limit:thing`.
      expect(f.key, "key").toMatch(/^([a-z_]+\.[a-z0-9_]+|limit:[a-z0-9_]+)$/);
      expect(f.nameEn.length, `${f.key} nameEn`).toBeGreaterThan(0);
      expect(f.nameHe.length, `${f.key} nameHe`).toBeGreaterThan(0);
      expect(typeof f.implemented, `${f.key} implemented`).toBe("boolean");
      expect(Array.isArray(f.enforcementLocations), `${f.key}`).toBe(true);
    }
  });

  it("keeps key shape and value type in agreement", () => {
    // A key's shape is how every caller reads it. `limit:` means a number to
    // compare against; a dotted key means a capability to switch on. If a
    // COUNTER ever hides behind a dotted key, `hasFeature` returns truthy for
    // the limit VALUE — so a limit of 0 reads as "allowed".
    for (const f of FEATURE_CATALOG) {
      const isLimitKey = f.key.startsWith("limit:");
      expect(isLimitKey, `${f.key} is ${f.entitlementType}`).toBe(f.entitlementType === "COUNTER");
    }
    // manager.support is ENUM behind a dotted key, and that is correct: it is a
    // capability whose value is a tier, not a quantity.
  });

  it("never sells a capability that is not built", () => {
    // The resolver's hard guard: implemented:false is denied by isUnsellable()
    // no matter what any layer says. This asserts the catalog side of it.
    const unbuilt = FEATURE_CATALOG.filter((f) => !f.implemented).map((f) => f.key);
    const sellable = new Set(sellableFeatureKeys());
    for (const k of unbuilt) expect(sellable.has(k), `${k} must not be sellable`).toBe(false);
  });

  it("does not grant an unbuilt capability on any plan", () => {
    const unbuilt = new Set(FEATURE_CATALOG.filter((f) => !f.implemented).map((f) => f.key));
    for (const k of CORE_FEATURES) {
      expect(unbuilt.has(k), `CORE_FEATURES grants unbuilt ${k}`).toBe(false);
    }
  });
});

describe("enforcementLocations is a contract, not prose", () => {
  const declared = FEATURE_CATALOG.filter(
    (f) => f.implemented && f.enforcementLocations.length > 0,
  );

  it("there is something to check", () => {
    expect(declared.length).toBeGreaterThan(0);
  });

  // The specific regression the audit found. Kept as its own named test so a
  // failure says what actually broke rather than "one of 20 features".
  it("communication.crm_summaries is ACTUALLY enforced where it claims", () => {
    const refs = enforcementRefs("communication.crm_summaries");
    expect(
      refs.length,
      "communication.crm_summaries claims enforcement but nothing references it. " +
        "Either gate the summary path or remove the claim from the catalog.",
    ).toBeGreaterThan(0);
    // It must be enforced on the background pipeline, not only at the HTTP edge:
    // a worker path that skips the gate is how the boundary went missing before.
    expect(refs.some((f) => f.includes("post-chat-pipeline"))).toBe(true);
  });

  it("reports which declared capabilities still have no enforcement reference", () => {
    const missing = declared
      .filter((f) => enforcementRefs(f.key).length === 0)
      .map((f) => f.key);

    // Not asserted to be empty. The audit measured ~9 of 90 capabilities
    // enforced, and closing that in one sprint would mean bolting middleware
    // onto paths nobody has thought about — which is how you ship a gate that
    // denies a paying customer. This test PRINTS the gap so it stays visible
    // and shrinks deliberately, and fails only if it GROWS past today's mark.
    if (missing.length) {
      console.warn(
        `[enforcement-contract] ${missing.length} capabilities declare enforcement ` +
          `with no code reference:\n  ${missing.join("\n  ")}`,
      );
    }
    // Ratchet: today's number. Lower it as capabilities get gated; never raise it.
    expect(missing.length).toBeLessThanOrEqual(17);
  });
});

describe("the bridge between the commercial key and the gate that reads it", () => {
  const bridged = FEATURE_CATALOG.filter((f) => f.materializesTo);

  it("bridges every capability whose gate reads a legacy key", () => {
    expect(bridged.length).toBeGreaterThan(0);
  });

  it("only ever points at a key that exists in lib/features.ts", () => {
    // A typo here is silent and total: `materializeEntitlements` writes a row
    // nobody reads, and the gate keeps answering from `defaultEnabled`. The
    // plan appears to control the capability and does not.
    const known = new Set(Object.keys(FEATURE_METADATA));
    for (const f of bridged) {
      expect(known.has(f.materializesTo!), `${f.key} -> unknown legacy key ${f.materializesTo}`).toBe(true);
    }
  });

  it("never bridges two capabilities onto the same legacy key", () => {
    // Two canonical keys writing one row means the last one materialized wins,
    // and withholding one capability silently withholds the other.
    const targets = bridged.map((f) => f.materializesTo!);
    expect(new Set(targets).size).toBe(targets.length);
  });

  it("bridges only BOOLEAN capabilities - materialization skips the rest", () => {
    // `materializeEntitlements` continues past anything non-BOOLEAN, so a
    // bridge on a COUNTER would never fire and would read as enforcement.
    for (const f of bridged) expect(f.entitlementType, f.key).toBe("BOOLEAN");
  });

  it("keeps the bridged default identical to the legacy default", () => {
    // The whole point of the bridge is that adding a commercial key changes
    // nothing for tenants who have the capability today. If the two defaults
    // disagree, the first materialization silently flips it for everyone.
    for (const f of bridged) {
      const legacyDefault = (FEATURE_METADATA as any)[f.materializesTo!]?.defaultEnabled;
      const catalogDefault = (f.defaultValue as any)?.bool;
      expect(catalogDefault, `${f.key} default disagrees with ${f.materializesTo}`).toBe(legacyDefault);
    }
  });
});

describe("the Foundation plan combination the product sells", () => {
  it("grants summaries as a CORE capability", () => {
    // Foundation denies ai.employee and ai.copilot but must still summarise.
    expect(CORE_FEATURES).toContain("communication.crm_summaries");
  });

  it("does NOT put AI Employee or Copilot in CORE", () => {
    // If either lands in CORE, Foundation silently gains a capability it does
    // not sell, and the plan boundary stops meaning anything.
    expect(CORE_FEATURES).not.toContain("ai.employee");
    expect(CORE_FEATURES).not.toContain("ai.copilot");
  });

  it("keeps auto-buy out of CORE - it spends the customer's money", () => {
    expect(CORE_FEATURES).not.toContain("commerce.auto_buy");
  });

  it("grants the Shopify commerce keys, preserving today's behaviour", () => {
    // Both had defaultEnabled:true under the legacy gate, so every tenant has
    // them today. Anything narrower would REMOVE a live capability.
    expect(CORE_FEATURES).toContain("commerce.shopify_live_chat");
    expect(CORE_FEATURES).toContain("commerce.shopify_product_messaging");
  });
});
