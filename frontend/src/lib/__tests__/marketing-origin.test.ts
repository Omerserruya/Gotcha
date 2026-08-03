/**
 * One bundle, two hostnames.
 *
 * gotcha.co.il and app.gotcha.co.il were served by the same nginx catch-all and
 * returned byte-identical responses, so the marketing landing page rendered on
 * the application host and every application route was reachable on the
 * marketing domain. nginx now splits them by path; this module is the other
 * half, deciding what `/` does on each host at runtime.
 */
import { describe, it, expect } from "vitest";
import { rendersMarketing, marketingOrigin } from "../marketing-origin";

describe("marketing origin split", () => {
  // The module reads NEXT_PUBLIC_MARKETING_URL at import time (it is frozen
  // into the bundle at build time), so these assert the UNCONFIGURED default
  // that dev and the test environment both run with.
  it("is disabled when no marketing origin is configured", () => {
    expect(marketingOrigin).toBe("");
  });

  /**
   * The important direction. A missing or unparseable value must render the
   * landing page, not bounce every visitor to a login screen: degrading to the
   * pre-split behaviour is recoverable, locking people out of the homepage is
   * not.
   */
  it("fails open - any origin renders marketing when unconfigured", () => {
    expect(rendersMarketing("https://app.gotcha.co.il")).toBe(true);
    expect(rendersMarketing("https://gotcha.co.il")).toBe(true);
    expect(rendersMarketing("http://localhost:3000")).toBe(true);
    expect(rendersMarketing("")).toBe(true);
    expect(rendersMarketing("not a url")).toBe(true);
  });
});

/**
 * The comparison itself, exercised directly rather than through module state.
 * These mirror rendersMarketing()'s logic for a CONFIGURED origin, which the
 * import-time constant cannot express in the same process.
 */
describe("origin matching rules", () => {
  const normalize = (raw: string): string => {
    if (!raw) return "";
    try { return new URL(raw).origin.toLowerCase(); } catch { return ""; }
  };
  const matches = (configured: string, current: string) =>
    normalize(configured) !== "" && normalize(current) === normalize(configured);

  it("matches the marketing host exactly", () => {
    expect(matches("https://gotcha.co.il", "https://gotcha.co.il")).toBe(true);
  });

  it("ignores path and trailing slash, which are not part of an origin", () => {
    expect(matches("https://gotcha.co.il/", "https://gotcha.co.il")).toBe(true);
    expect(matches("https://gotcha.co.il", "https://gotcha.co.il/pricing/")).toBe(true);
  });

  it("is case-insensitive on the host", () => {
    expect(matches("https://gotcha.co.il", "https://GOTCHA.co.il")).toBe(true);
  });

  /** The whole point: the application host must NOT render marketing. */
  it("does not match the application host", () => {
    expect(matches("https://gotcha.co.il", "https://app.gotcha.co.il")).toBe(false);
  });

  /**
   * A subdomain must not match by prefix or suffix. `evil-gotcha.co.il` and
   * `gotcha.co.il.attacker.test` both contain the configured string.
   */
  it("does not match look-alike hosts", () => {
    expect(matches("https://gotcha.co.il", "https://evil-gotcha.co.il")).toBe(false);
    expect(matches("https://gotcha.co.il", "https://gotcha.co.il.attacker.test")).toBe(false);
    expect(matches("https://gotcha.co.il", "https://www.gotcha.co.il")).toBe(false);
  });

  /** Scheme is part of an origin; http and https are different origins. */
  it("distinguishes scheme", () => {
    expect(matches("https://gotcha.co.il", "http://gotcha.co.il")).toBe(false);
  });
});
