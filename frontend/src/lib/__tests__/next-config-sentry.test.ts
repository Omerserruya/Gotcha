/**
 * The browser SDK must exist whenever a DSN is baked in.
 *
 * withSentryConfig is what injects sentry.client.config.ts into the bundle.
 * An earlier version of this config gated the whole wrapper on the SOURCE-MAP
 * UPLOAD credentials, so a production build with a real DSN but no
 * SENTRY_AUTH_TOKEN shipped with no SDK at all - the DSN was set, the bundle
 * was silent, and nothing in the build output said so. It was only caught by
 * grepping the built image for the DSN host.
 *
 * These are two independent decisions and this test keeps them apart:
 *   wrap    needed for the SDK to exist        -> DSN present
 *   upload  needed for readable stack traces   -> credentials present
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const CONFIG = fs.readFileSync(path.join(__dirname, "..", "..", "..", "next.config.js"), "utf8");

describe("next.config.js Sentry wiring", () => {
  it("decides to WRAP on the DSN, not on upload credentials", () => {
    const wrapCondition = /const sentryDsnPresent =([\s\S]*?);/.exec(CONFIG)?.[1] ?? "";
    expect(wrapCondition).toMatch(/SENTRY_DSN|SENTRY_FRONTEND_DSN/);
    for (const cred of ["SENTRY_AUTH_TOKEN", "SENTRY_ORG"]) {
      expect(wrapCondition, `wrapping must not depend on ${cred}`).not.toContain(cred);
    }
  });

  it("decides to UPLOAD on the credentials and an explicit production release", () => {
    const upload = /const sentryUploadRequested =([\s\S]*?);/.exec(CONFIG)?.[1] ?? "";
    for (const req of ["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_RELEASE"]) {
      expect(upload, `upload must require ${req}`).toContain(req);
    }
    expect(upload).toContain('SENTRY_ENVIRONMENT === "production"');
  });

  it("skips the wrapper entirely with no DSN, so a laptop build needs nothing", () => {
    expect(CONFIG).toMatch(/if \(!sentryDsnPresent\) \{[\s\S]*?module\.exports = nextConfig;/);
  });

  /** A tunnel needs a server to proxy through; production is a static export. */
  it("leaves tunnelRoute disabled", () => {
    expect(CONFIG).toMatch(/tunnelRoute:\s*undefined/);
  });
});
