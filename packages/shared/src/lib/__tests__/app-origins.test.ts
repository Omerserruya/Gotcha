import { describe, it, expect } from "vitest";
import {
  normalizeOrigin,
  loadOriginPolicy,
  isAllowedOrigin,
  assertAppOriginReady,
  AppOriginError,
} from "../app-origins";

describe("normalizeOrigin", () => {
  it("normalizes to scheme://host[:port], dropping path and default port", () => {
    expect(normalizeOrigin("https://App.Gotcha.co.il/")).toBe("https://app.gotcha.co.il");
    expect(normalizeOrigin("https://app.gotcha.co.il:443")).toBe("https://app.gotcha.co.il");
    expect(normalizeOrigin("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("rejects wildcards, paths, and non-http schemes", () => {
    for (const bad of ["*", "https://*.gotcha.co.il", "https://app.gotcha.co.il/x", "ftp://x", "not a url"]) {
      expect(() => normalizeOrigin(bad)).toThrow(AppOriginError);
    }
  });
});

describe("origin allow-list (exact match, no endsWith)", () => {
  const policy = loadOriginPolicy({
    NODE_ENV: "development",
    APP_ORIGIN: "https://app.gotcha.co.il",
    AUTH_ALLOWED_ORIGINS: "https://dev.gotcha.co.il, http://localhost:3000",
  } as any);

  it("allows exactly the configured origins", () => {
    expect(isAllowedOrigin("https://app.gotcha.co.il", policy)).toBe(true);
    expect(isAllowedOrigin("https://dev.gotcha.co.il", policy)).toBe(true);
    expect(isAllowedOrigin("http://localhost:3000", policy)).toBe(true);
  });

  it("rejects suffix/substring look-alikes (the endsWith attack)", () => {
    expect(isAllowedOrigin("https://app.gotcha.co.il.attacker.com", policy)).toBe(false);
    expect(isAllowedOrigin("https://evil-app.gotcha.co.il", policy)).toBe(false);
    expect(isAllowedOrigin("http://app.gotcha.co.il", policy)).toBe(false); // scheme differs
    expect(isAllowedOrigin("https://app.gotcha.co.il:8443", policy)).toBe(false); // port differs
  });
});

describe("production startup guard", () => {
  it("fails when APP_ORIGIN is absent", () => {
    expect(() => assertAppOriginReady({ NODE_ENV: "production" } as any)).toThrow(/app_origin_required_in_production/);
  });
  it("fails when the production origin is not https", () => {
    expect(() => assertAppOriginReady({ NODE_ENV: "production", APP_ORIGIN: "http://app.gotcha.co.il" } as any)).toThrow(/prod_requires_https/);
  });
  it("passes with a valid https production origin", () => {
    expect(() => assertAppOriginReady({ NODE_ENV: "production", APP_ORIGIN: "https://app.gotcha.co.il" } as any)).not.toThrow();
  });
});
