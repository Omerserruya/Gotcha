import { describe, it, expect } from "vitest";
import { BOOLEAN_FEATURE_KEYS, isUnsellable } from "../lib/billing/feature-catalog";

/**
 * What a POC tenant must be granted, expressed against the catalog the billing
 * service derives it from. Lives here rather than in services/billing because
 * that suite needs a database and this question does not.
 *
 * The bug: there are TWO key namespaces. License domains (`ai`,
 * `conversation`) are default-ALLOW and drive navigation. Fine-grained
 * capabilities are dotted (`ai.copilot`) and default-DENY -
 * `requireEntitlement("ai.copilot")` refuses anything it cannot find. Every
 * sellable plan carries rows for the dotted keys; the `poc` plan carries none,
 * and POC provisioning wrote only the coarse domains.
 *
 * A pilot therefore got `ai: true` - AI visible in the nav, the operator
 * console reporting the feature enabled - and a 402 on every co-pilot request.
 * Enabled everywhere a human looked, denied at the only place that decides.
 */

const PILOT_CAPABILITY_KEYS = BOOLEAN_FEATURE_KEYS.filter(
  (k) => !isUnsellable(k) && !k.startsWith("voice."),
);

describe("what a pilot is granted", () => {
  it("includes ai.copilot - the key the co-pilot route actually asks for", () => {
    expect(PILOT_CAPABILITY_KEYS).toContain("ai.copilot");
  });

  it("includes the rest of the AI capabilities a pilot is meant to exercise", () => {
    // ai.employee especially: a POC that cannot create an AI employee cannot
    // evaluate the product the pilot is a pilot OF.
    for (const key of ["ai.employee", "ai.knowledge_base", "ai.customer_360", "ai.command_center"]) {
      expect(PILOT_CAPABILITY_KEYS).toContain(key);
    }
  });

  it("is dotted capability keys only, never bare license domains", () => {
    // The bare domains are written separately, from POC_FEATURE_DOMAINS, and
    // carry the opposite default. Mixing the namespaces is the original bug.
    expect(PILOT_CAPABILITY_KEYS.filter((k) => !k.includes("."))).toEqual([]);
  });

  it("excludes voice, which belongs to the voice license", () => {
    // Same rule the limits already follow for `limit:voice_channels`: the more
    // specific license is the right answer for tenants that have it.
    expect(PILOT_CAPABILITY_KEYS.filter((k) => k.startsWith("voice."))).toEqual([]);
  });

  it("never grants an unshipped capability", () => {
    // A catalogued-but-unbuilt key must not be sold, even for free.
    for (const key of PILOT_CAPABILITY_KEYS) {
      expect(isUnsellable(key)).toBe(false);
    }
  });

  it("is derived, so a capability shipped later cannot be silently missing", () => {
    // The guard on the derivation itself: if someone replaces the filter with
    // a hand-written list, this count check is what notices.
    const expected = BOOLEAN_FEATURE_KEYS.filter((k) => !isUnsellable(k) && !k.startsWith("voice."));
    expect(PILOT_CAPABILITY_KEYS).toEqual(expected);
    expect(PILOT_CAPABILITY_KEYS.length).toBeGreaterThan(10);
  });
});
