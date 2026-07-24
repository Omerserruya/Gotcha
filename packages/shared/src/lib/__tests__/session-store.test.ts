import { describe, it, expect } from "vitest";
import {
  expiredSessionsWhere,
  revokedSessionsWhere,
  identitySessionsWhere,
  staleVersionSessionsWhere,
  membershipSessionsWhere,
  isSessionUsable,
  toSafeSessionView,
  readSessionTtl,
  assertSessionInfraReady,
  SESSION_SECRET_FIELDS,
} from "../session-store";

const now = new Date("2026-07-24T12:00:00Z");

describe("session-store query builders", () => {
  it("build the expected where clauses", () => {
    expect(expiredSessionsWhere(now)).toEqual({ expiresAt: { lt: now } });
    expect(identitySessionsWhere("id1")).toEqual({ identityId: "id1", revokedAt: null });
    expect(staleVersionSessionsWhere("id1", 3)).toEqual({ identityId: "id1", sessionVersion: { lt: 3 } });
    expect(membershipSessionsWhere("m1")).toEqual({ activeMembershipId: "m1", revokedAt: null });
    expect(revokedSessionsWhere(now)).toEqual({ revokedAt: { not: null, lt: now } });
  });
});

describe("isSessionUsable", () => {
  const base = { revokedAt: null as Date | null, expiresAt: new Date("2026-07-24T13:00:00Z"), sessionVersion: 5 };
  it("true only when live, unexpired and version-current", () => {
    expect(isSessionUsable(base, 5, now)).toBe(true);
    expect(isSessionUsable({ ...base, revokedAt: now }, 5, now)).toBe(false);
    expect(isSessionUsable({ ...base, expiresAt: new Date("2026-07-24T11:00:00Z") }, 5, now)).toBe(false);
    expect(isSessionUsable({ ...base, sessionVersion: 4 }, 5, now)).toBe(false); // global bump
  });
});

describe("toSafeSessionView redaction", () => {
  it("omits every secret field", () => {
    const row = {
      id: "s1", identityId: "id1", activeMembershipId: "m1",
      sessionTokenHash: "HASH", encryptedAccessToken: "SEALED", encryptedRefreshToken: "SEALED2",
      csrfSecret: "CSRF", rememberMe: true, createdAt: now, lastActivityAt: now, expiresAt: now,
      revokedAt: null, revocationReason: null, browser: "Chrome", device: "Mac", operatingSystem: "macOS",
    };
    const view = toSafeSessionView(row) as unknown as Record<string, unknown>;
    for (const secret of SESSION_SECRET_FIELDS) expect(view[secret]).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("SEALED");
    expect(JSON.stringify(view)).not.toContain("CSRF");
    expect(JSON.stringify(view)).not.toContain("HASH");
    expect(view.browser).toBe("Chrome");
  });
});

describe("readSessionTtl", () => {
  it("defaults to 12h / 30d and honors overrides", () => {
    expect(readSessionTtl({} as any)).toEqual({ idleSeconds: 43200, rememberedSeconds: 2592000 });
    expect(readSessionTtl({ SESSION_IDLE_TTL_SECONDS: "3600", SESSION_REMEMBER_TTL_SECONDS: "86400" } as any)).toEqual({ idleSeconds: 3600, rememberedSeconds: 86400 });
  });
});

describe("assertSessionInfraReady (gated on flags)", () => {
  it("is a NO-OP when cookie infra is disabled, even with no key/origin set", () => {
    expect(() => assertSessionInfraReady({ NODE_ENV: "production" } as any)).not.toThrow();
  });
  it("enforces the guards once cookie infra is enabled in production", () => {
    expect(() => assertSessionInfraReady({ NODE_ENV: "production", SESSION_COOKIE_ACCEPT: "true" } as any)).toThrow();
  });
});
