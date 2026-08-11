/**
 * One bundle, two hostnames.
 *
 * gotcha.co.il and app.gotcha.co.il were served by the same nginx catch-all and
 * returned byte-identical responses, so the marketing landing page rendered on
 * the application host and every application route was reachable on the
 * marketing domain. nginx now splits them by path; this module is the other
 * half, deciding what `/` does on each host at runtime.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { rendersMarketing, marketingOrigin, isMarketingHost, loginUrl } from "../marketing-origin";

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

/**
 * The unconfigured (dev / single-host) contract for the login hop.
 *
 * isMarketingHost() is NOT the negation of rendersMarketing(): with no split
 * configured every origin renders marketing, yet NO origin is "the marketing
 * host", because there is no other host to send anyone to.
 */
describe("login hop - unconfigured", () => {
  it("no origin is the marketing host when no split is configured", () => {
    expect(isMarketingHost("https://gotcha.co.il")).toBe(false);
    expect(isMarketingHost("https://app.gotcha.co.il")).toBe(false);
    expect(isMarketingHost("http://localhost:3000")).toBe(false);
  });

  it("keeps /login relative, so dev never leaves the single host", () => {
    expect(loginUrl("http://localhost:3000")).toBe("/login");
    expect(loginUrl("https://gotcha.co.il")).toBe("/login");
  });

  it("still threads ?next= through", () => {
    expect(loginUrl("http://localhost:3000", "/setup")).toBe("/login?next=%2Fsetup");
  });
});

/**
 * The production split, loaded with the two NEXT_PUBLIC_* values prod is built
 * with. Both are read at import time, so each case needs a fresh module.
 *
 * This is the regression that stranded visitors: a relative `/login` on the
 * marketing origin was resolved client-side, so nginx's redirect to the
 * application host never ran and Authentik - which grants OIDC CORS only to the
 * origin registered as its redirect URI - refused the discovery fetch.
 */
describe("login hop - production split", () => {
  const load = async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_MARKETING_URL", "https://gotcha.co.il");
    vi.stubEnv("NEXT_PUBLIC_OIDC_REDIRECT_URI", "https://app.gotcha.co.il/auth/callback");
    return import("../marketing-origin");
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("derives the application origin from the OIDC callback", async () => {
    const m = await load();
    expect(m.appOrigin).toBe("https://app.gotcha.co.il");
  });

  it("identifies the marketing host and only the marketing host", async () => {
    const m = await load();
    expect(m.isMarketingHost("https://gotcha.co.il")).toBe(true);
    expect(m.isMarketingHost("https://gotcha.co.il/pricing/")).toBe(true);
    expect(m.isMarketingHost("https://app.gotcha.co.il")).toBe(false);
    expect(m.isMarketingHost("https://www.gotcha.co.il")).toBe(false);
  });

  it("sends the marketing host to an ABSOLUTE url on the application host", async () => {
    const m = await load();
    expect(m.loginUrl("https://gotcha.co.il")).toBe("https://app.gotcha.co.il/login");
  });

  it("leaves the application host relative - no pointless cross-origin hop", async () => {
    const m = await load();
    expect(m.loginUrl("https://app.gotcha.co.il")).toBe("/login");
  });

  it("carries ?next= across the hop", async () => {
    const m = await load();
    expect(m.loginUrl("https://gotcha.co.il", "/setup")).toBe(
      "https://app.gotcha.co.il/login?next=%2Fsetup",
    );
  });

  /**
   * An open-redirect guard, not a formatting rule: `next` reaches the app host
   * as a URL parameter, so an absolute value would be a way to have GOTCHA's
   * own login bounce a user to another site after authenticating.
   */
  it("drops a non-relative next rather than forwarding it", async () => {
    const m = await load();
    expect(m.loginUrl("https://gotcha.co.il", "https://evil.test")).toBe(
      "https://app.gotcha.co.il/login",
    );
    // Starts with "/" but is protocol-relative: browsers resolve it to
    // https://evil.test, so a naive startsWith("/") check lets it through.
    expect(m.loginUrl("https://gotcha.co.il", "//evil.test")).toBe(
      "https://app.gotcha.co.il/login",
    );
    expect(m.loginUrl("https://gotcha.co.il", "/\\evil.test")).toBe(
      "https://app.gotcha.co.il/login",
    );
  });

  /**
   * Fail SAFE, not open: with no callback configured there is no application
   * origin to name, so stay relative and let nginx's redirect handle the hop
   * rather than inventing a hostname.
   */
  it("stays relative when no OIDC callback is configured", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_MARKETING_URL", "https://gotcha.co.il");
    vi.stubEnv("NEXT_PUBLIC_OIDC_REDIRECT_URI", "");
    const m = await import("../marketing-origin");
    expect(m.appOrigin).toBe("");
    expect(m.loginUrl("https://gotcha.co.il")).toBe("/login");
  });
});
