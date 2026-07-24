import { describe, it, expect } from "vitest";
import {
  parseSessionCookie,
  serializeSessionCookie,
  serializeClearedSessionCookie,
  resolveSessionCookieContract,
  SessionCookieError,
  PROD_SESSION_COOKIE_NAME,
  DEV_SESSION_COOKIE_NAME,
} from "../session-cookie";

const NAME = PROD_SESSION_COOKIE_NAME;

describe("parseSessionCookie", () => {
  it("extracts the value, returns null when absent", () => {
    expect(parseSessionCookie(`${NAME}=abc123; other=1`, NAME)).toBe("abc123");
    expect(parseSessionCookie("other=1", NAME)).toBeNull();
    expect(parseSessionCookie("", NAME)).toBeNull();
    expect(parseSessionCookie(undefined, NAME)).toBeNull();
  });

  it("rejects a duplicate session cookie (ambiguous)", () => {
    expect(() => parseSessionCookie(`${NAME}=a; ${NAME}=b`, NAME)).toThrow(SessionCookieError);
  });

  it("rejects control characters / malformed input", () => {
    expect(() => parseSessionCookie(`${NAME}=a\x00b`, NAME)).toThrow(SessionCookieError);
    expect(() => parseSessionCookie(`${NAME}=`, NAME)).toThrow(SessionCookieError);
  });

  it("unwraps a quoted value", () => {
    expect(parseSessionCookie(`${NAME}="abc"`, NAME)).toBe("abc");
  });
});

describe("cookie contract by environment", () => {
  it("production = __Host- + Secure + Lax + Path=/ + no Domain", () => {
    const c = resolveSessionCookieContract({ NODE_ENV: "production" } as any);
    expect(c.name).toBe(PROD_SESSION_COOKIE_NAME);
    expect(c.secure).toBe(true);
    expect(c.sameSite).toBe("Lax");
    expect(c.path).toBe("/");
    expect(c.domain).toBeUndefined();
    expect(c.httpOnly).toBe(true);
  });

  it("local dev uses a distinct non-__Host- name, Secure optional", () => {
    const c = resolveSessionCookieContract({ NODE_ENV: "development" } as any);
    expect(c.name).toBe(DEV_SESSION_COOKIE_NAME);
    expect(c.name.startsWith("__Host-")).toBe(false);
    expect(c.secure).toBe(false);
  });

  it("production REJECTS a non-__Host- cookie name (never weakened for localhost)", () => {
    expect(() => resolveSessionCookieContract({ NODE_ENV: "production", SESSION_COOKIE_NAME: "gotcha_session_dev" } as any)).toThrow(/host_prefix/);
  });
});

describe("serializeSessionCookie", () => {
  it("emits the exact production attribute set with NO Domain", () => {
    const sc = serializeSessionCookie("opaqueval", { maxAgeSeconds: 3600, env: { NODE_ENV: "production" } as any });
    expect(sc.startsWith(`${PROD_SESSION_COOKIE_NAME}=opaqueval`)).toBe(true);
    expect(sc).toContain("HttpOnly");
    expect(sc).toContain("Secure");
    expect(sc).toContain("SameSite=Lax");
    expect(sc).toContain("Path=/");
    expect(sc).toContain("Max-Age=3600");
    expect(sc).not.toMatch(/Domain=/i);
  });

  it("rejects a value with control chars / semicolons and a bad max-age", () => {
    expect(() => serializeSessionCookie("a;b", { maxAgeSeconds: 10, env: { NODE_ENV: "production" } as any })).toThrow(SessionCookieError);
    expect(() => serializeSessionCookie("ok", { maxAgeSeconds: -1, env: { NODE_ENV: "production" } as any })).toThrow(SessionCookieError);
  });

  it("a __Host- contract that is not Secure is refused", () => {
    expect(() =>
      serializeSessionCookie("v", { maxAgeSeconds: 10, contract: { name: PROD_SESSION_COOKIE_NAME, secure: false, sameSite: "Lax", path: "/", domain: undefined, httpOnly: true } }),
    ).toThrow(/host_prefix_requires_secure/);
  });

  it("clears the cookie with Max-Age=0", () => {
    expect(serializeClearedSessionCookie({ NODE_ENV: "production" } as any)).toContain("Max-Age=0");
  });
});
