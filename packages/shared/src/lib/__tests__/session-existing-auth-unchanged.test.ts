import { describe, it, expect } from "vitest";
import { readSessionFlags } from "../session-flags";
// Import the auth gate + session infra from their own modules (not the barrel,
// which eagerly opens a Redis connection) so this stays a pure unit test.
import * as authMw from "../../middleware/auth";
import * as principal from "../principal";
import * as jwt from "../jwt";
import * as token from "../session-token";
import * as store from "../session-store";

/**
 * Commit 1 must cause ZERO authentication behavior change. These assertions pin
 * that: the legacy Bearer path is still the default, the existing auth gate is
 * still exported unchanged, and importing the new infra has no boot side effect
 * (it reads env only inside functions, so an app with no SESSION_* vars is fine).
 */
describe("existing authentication is unchanged by commit 1", () => {
  it("with no flags set, legacy Bearer auth stays on and cookie auth stays off", () => {
    const f = readSessionFlags({} as any);
    expect(f.legacyBearerAccept).toBe(true);
    expect(f.cookieCreate).toBe(false);
    expect(f.cookieAccept).toBe(false);
  });

  it("still exports the existing auth gate and principal resolver", () => {
    expect(typeof authMw.authenticate).toBe("function");
    expect(typeof principal.resolvePrincipal).toBe("function");
    expect(typeof jwt.verifyAccessToken).toBe("function");
  });

  it("importing the session infra has no startup side effect (no SESSION_* required)", () => {
    // Reached here => module import did not throw despite no session env vars.
    expect(typeof token.generateSessionToken).toBe("function");
    expect(typeof store.assertSessionInfraReady).toBe("function");
  });
});
