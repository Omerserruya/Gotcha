import { describe, it, expect } from "vitest";
import { readSessionFlags, sessionInfraEnabled } from "../session-flags";

describe("session feature flags", () => {
  it("defaults every NEW behavior to disabled and every LEGACY behavior to on", () => {
    const f = readSessionFlags({} as any);
    expect(f.cookieCreate).toBe(false);
    expect(f.cookieAccept).toBe(false);
    expect(f.cookieOnlyEnforce).toBe(false);
    expect(f.legacyBearerAccept).toBe(true);
    expect(f.browserTokenIssue).toBe(true);
    expect(sessionInfraEnabled(f)).toBe(false);
  });

  it("honors explicit overrides", () => {
    const f = readSessionFlags({ SESSION_COOKIE_CREATE: "true", SESSION_COOKIE_ACCEPT: "1", LEGACY_BEARER_ACCEPT: "false" } as any);
    expect(f.cookieCreate).toBe(true);
    expect(f.cookieAccept).toBe(true);
    expect(f.legacyBearerAccept).toBe(false);
    expect(sessionInfraEnabled(f)).toBe(true);
  });
});
