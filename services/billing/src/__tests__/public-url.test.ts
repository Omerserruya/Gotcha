/**
 * The URLs a customer is sent back through after paying.
 *
 * These end up in front of someone mid-payment, handed over by a payment
 * provider. The failure modes are a stranded customer (no return URL), a
 * phishing page wearing our checkout flow (an origin from a request), and an
 * intercepted payment (http in production).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  appPublicUrl,
  buildReturnUrl,
  assertPublicUrlConfigured,
  PublicUrlMisconfigured,
} from "../lib/public-url";

const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env.APP_PUBLIC_URL = "https://app.gotcha.co.il";
  delete process.env.APP_PUBLIC_URL_ALLOWED_HOSTS;
  delete process.env.NODE_ENV;
});
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("the configured origin", () => {
  it("strips a trailing slash", () => {
    process.env.APP_PUBLIC_URL = "https://app.gotcha.co.il/";
    expect(appPublicUrl()).toBe("https://app.gotcha.co.il");
  });

  it("refuses to be absent", () => {
    delete process.env.APP_PUBLIC_URL;
    // Returning undefined is what stranded a customer on the provider's page.
    expect(() => appPublicUrl()).toThrow(/is not set/);
  });

  it.each(["not-a-url", "app.gotcha.co.il", "", "   "])("refuses %o", (value) => {
    process.env.APP_PUBLIC_URL = value;
    expect(() => appPublicUrl()).toThrow(PublicUrlMisconfigured);
  });

  it("refuses a non-web scheme", () => {
    process.env.APP_PUBLIC_URL = "javascript:alert(1)";
    expect(() => appPublicUrl()).toThrow();
  });

  it("refuses embedded credentials", () => {
    process.env.APP_PUBLIC_URL = "https://user:pass@app.gotcha.co.il";
    expect(() => appPublicUrl()).toThrow(/credentials/);
  });

  it("allows http outside production", () => {
    process.env.APP_PUBLIC_URL = "http://localhost:3000";
    expect(appPublicUrl()).toBe("http://localhost:3000");
  });

  it("refuses http in production", () => {
    process.env.NODE_ENV = "production";
    process.env.APP_PUBLIC_URL = "http://app.gotcha.co.il";
    expect(() => appPublicUrl()).toThrow(/https in production/);
  });
});

describe("the host allowlist", () => {
  it("is inactive when unset", () => {
    expect(appPublicUrl()).toBe("https://app.gotcha.co.il");
  });

  it("accepts a listed host", () => {
    process.env.APP_PUBLIC_URL_ALLOWED_HOSTS = "app.gotcha.co.il, dev.gotcha.co.il";
    expect(appPublicUrl()).toBe("https://app.gotcha.co.il");
  });

  it("refuses an unlisted host", () => {
    process.env.APP_PUBLIC_URL_ALLOWED_HOSTS = "app.gotcha.co.il";
    process.env.APP_PUBLIC_URL = "https://gotcha.co.il.evil.example";
    expect(() => appPublicUrl()).toThrow(/not in APP_PUBLIC_URL_ALLOWED_HOSTS/);
  });
});

describe("a return URL cannot leave our origin", () => {
  it("builds from a path", () => {
    expect(buildReturnUrl("/checkout/done", { ref: "chk_1" })).toBe(
      "https://app.gotcha.co.il/checkout/done?ref=chk_1",
    );
  });

  it("encodes the reference", () => {
    const url = buildReturnUrl("/checkout/done", { ref: "a b&c=d" });
    expect(url).toContain("ref=a+b%26c%3Dd");
    expect(new URL(url).searchParams.get("ref")).toBe("a b&c=d");
  });

  it.each([
    "//evil.example/checkout",
    "https://evil.example/checkout",
    "http://evil.example",
    "javascript:alert(1)",
    "checkout/done",
  ])("refuses %o as a return path", (path) => {
    // Each of these is an open redirect if it gets through: the customer is
    // handed this URL by a payment provider, wearing our flow.
    expect(() => buildReturnUrl(path)).toThrow(PublicUrlMisconfigured);
  });

  it("keeps a traversal attempt on our origin", () => {
    // Not an error - just resolved, and still ours, which is what matters.
    expect(new URL(buildReturnUrl("/checkout/../evil")).origin).toBe("https://app.gotcha.co.il");
  });
});

describe("startup validation", () => {
  it("says nothing when no payment capability is on", () => {
    delete process.env.APP_PUBLIC_URL;
    // The suite runs with the capabilities ON (see vitest.config.ts), so this
    // case has to say so rather than inherit it.
    for (const v of [
      "ICOUNT_CHECKOUT_ENABLED",
      "ICOUNT_TOKENIZATION_ENABLED",
      "ICOUNT_STORED_CARD_CHARGE_ENABLED",
      "SELF_SERVE_CHECKOUT_ENABLED",
    ]) delete process.env[v];
    // A stack that cannot send anyone to a payment page does not need one.
    expect(() => assertPublicUrlConfigured()).not.toThrow();
  });

  it.each([
    "ICOUNT_CHECKOUT_ENABLED",
    "ICOUNT_TOKENIZATION_ENABLED",
    "ICOUNT_STORED_CARD_CHARGE_ENABLED",
    "SELF_SERVE_CHECKOUT_ENABLED",
  ])("refuses to start with %s on and no public URL", (flag) => {
    delete process.env.APP_PUBLIC_URL;
    const base = { ...process.env };
    for (const v of [
      "ICOUNT_CHECKOUT_ENABLED",
      "ICOUNT_TOKENIZATION_ENABLED",
      "ICOUNT_STORED_CARD_CHARGE_ENABLED",
      "SELF_SERVE_CHECKOUT_ENABLED",
    ]) delete base[v];
    const env = { ...base, [flag]: "true" } as NodeJS.ProcessEnv;
    expect(() => assertPublicUrlConfigured(env)).toThrow(/is not set/);
  });

  it("starts when payments are on and the URL is valid", () => {
    const env = { ...process.env, ICOUNT_CHECKOUT_ENABLED: "true" } as NodeJS.ProcessEnv;
    expect(() => assertPublicUrlConfigured(env)).not.toThrow();
  });
});
