import { describe, it, expect } from "vitest";
import { openSessionSecret, hashSessionToken } from "@chatcenter/shared";
import { buildSessionRecord, chooseActiveMembership } from "../lib/session-factory";

const ENV = { NODE_ENV: "test", SESSION_ENCRYPTION_KEY: "0f".repeat(32) } as any;
const TOKENS = { access_token: "the-access-token", refresh_token: "the-refresh-token", id_token: "id", expires_in: 1800 };
const now = new Date("2026-07-26T12:00:00Z");

describe("buildSessionRecord", () => {
  const built = buildSessionRecord({
    tokens: TOKENS, identityId: "id_1", identitySessionVersion: 3,
    activeMembershipId: "mem_1", rememberMe: false, userAgent: "UA/1", ip: "1.2.3.4", now, env: ENV,
  });

  it("returns an opaque cookie value that is stored only as its hash", () => {
    expect(built.rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(built.createData.sessionTokenHash).toBe(hashSessionToken(built.rawToken));
    // Raw token never appears in the persisted record.
    expect(JSON.stringify(built.createData)).not.toContain(built.rawToken);
  });

  it("seals provider tokens (no plaintext) and they decrypt with the right context", () => {
    const d = built.createData as any;
    expect(d.encryptedAccessToken).not.toContain("the-access-token");
    expect(openSessionSecret(d.encryptedAccessToken, { purpose: "session.access", ownerId: "id_1" }, ENV)).toBe("the-access-token");
    expect(openSessionSecret(d.encryptedRefreshToken, { purpose: "session.refresh", ownerId: "id_1" }, ENV)).toBe("the-refresh-token");
    // Wrong identity/context cannot open it.
    expect(() => openSessionSecret(d.encryptedAccessToken, { purpose: "session.access", ownerId: "id_2" }, ENV)).toThrow();
  });

  it("snapshots sessionVersion + sets a __Host secure cookie with the right lifetime", () => {
    const d = built.createData as any;
    expect(d.sessionVersion).toBe(3);
    expect(d.activeMembershipId).toBe("mem_1");
    expect(d.tokenExpiresAt).toEqual(new Date(now.getTime() + 1800 * 1000));
    // non-remembered → 12h default idle TTL
    expect(d.expiresAt).toEqual(new Date(now.getTime() + 43200 * 1000));
    expect(built.setCookie).toContain("__Host-gotcha_session=");
    expect(built.setCookie).toMatch(/HttpOnly/);
    expect(built.setCookie).toMatch(/SameSite=Lax/);
    expect(built.setCookie).not.toMatch(/Domain=/i);
    // device metadata is hashed, never raw
    expect(d.userAgentHash).not.toBe("UA/1");
    expect(d.ipHash).not.toBe("1.2.3.4");
  });

  it("remembered sessions get the long TTL", () => {
    const r = buildSessionRecord({ tokens: TOKENS, identityId: "id_1", identitySessionVersion: 0, activeMembershipId: null, rememberMe: true, now, env: ENV });
    expect((r.createData as any).expiresAt).toEqual(new Date(now.getTime() + 2592000 * 1000)); // 30d
    expect(r.setCookie).toContain("Max-Age=2592000");
  });
});

describe("chooseActiveMembership", () => {
  const m = (id: string, tenantId: string, isActive = true) => ({ id, tenantId, isActive });
  it("auto-selects a single active membership", () => {
    expect(chooseActiveMembership([m("a", "t1")], null)).toBe("a");
  });
  it("prefers the last-used tenant when several are active", () => {
    expect(chooseActiveMembership([m("a", "t1"), m("b", "t2")], "t2")).toBe("b");
  });
  it("returns null (picker) when ambiguous or none active", () => {
    expect(chooseActiveMembership([m("a", "t1"), m("b", "t2")], null)).toBeNull();
    expect(chooseActiveMembership([m("a", "t1", false)], null)).toBeNull();
  });
});
