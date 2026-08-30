/**
 * Shopify app-entry verification.
 *
 * This is the gate between "someone made a GET request" and "we redirect a
 * merchant's browser to a host and later store an access token against it".
 * Every test below is a shape that must NOT get through, plus the one that
 * must.
 *
 * The signature is computed the way Shopify computes it (sorted params minus
 * `hmac`, joined with `&`, HMAC-SHA256 hex) rather than by calling the
 * production helper, so a bug in the helper cannot make its own tests pass.
 */

import { describe, it, expect } from "vitest";
import crypto from "crypto";
import {
  verifyAppEntryHmac,
  verifyOAuthCallbackHmac,
  strictShopDomain,
  isFreshAppEntryTimestamp,
  buildShopifyAuthorizeUrl,
  resolveShopifyInstallUrl,
  APP_ENTRY_MAX_AGE_SECONDS,
} from "../lib/shopify-install";

const SECRET = "shpss_test_secret_do_not_use";
const SHOP = "urban-supply-dev.myshopify.com";

/** Sign a query the way Shopify does. Independent of the code under test. */
function sign(params: Record<string, string>, secret = SECRET): string {
  const message = Object.keys(params)
    .filter((k) => k !== "hmac" && k !== "signature")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto.createHmac("sha256", secret).update(message, "utf8").digest("hex");
}

function entry(over: Record<string, string> = {}, now = new Date()): Record<string, string> {
  const base: Record<string, string> = {
    shop: SHOP,
    timestamp: String(Math.floor(now.getTime() / 1000)),
    host: "dXJiYW4tc3VwcGx5LWRldi5teXNob3BpZnkuY29t",
    ...over,
  };
  return { ...base, hmac: sign(base) };
}

describe("strictShopDomain", () => {
  it("accepts Shopify's canonical form", () => {
    expect(strictShopDomain(SHOP)).toBe(SHOP);
    expect(strictShopDomain("  URBAN-SUPPLY-DEV.MYSHOPIFY.COM  ")).toBe(SHOP);
  });

  it("refuses to COMPLETE a bare slug into a host Shopify never sent", () => {
    // The forgiving normalizer would return "evil.myshopify.com" here. On a
    // signed request that would be inventing a store.
    expect(strictShopDomain("evil")).toBeNull();
  });

  it("refuses the lookalikes that turn a shop param into a redirect target", () => {
    for (const bad of [
      "evil.com",
      "myshopify.com",
      ".myshopify.com",
      "shop.myshopify.com.evil.com",
      "a.b.myshopify.com",
      "https://urban-supply-dev.myshopify.com",
      "urban-supply-dev.myshopify.com/admin",
      "urban-supply-dev.myshopify.com:8443",
      "urban supply.myshopify.com",
      "-leading-dash.myshopify.com",
    ]) {
      expect(strictShopDomain(bad), bad).toBeNull();
    }
  });

  it("refuses non-strings, including the array Express builds for ?shop=a&shop=b", () => {
    expect(strictShopDomain([SHOP, SHOP] as unknown)).toBeNull();
    expect(strictShopDomain(undefined)).toBeNull();
    expect(strictShopDomain(null)).toBeNull();
    expect(strictShopDomain(123)).toBeNull();
  });
});

describe("isFreshAppEntryTimestamp", () => {
  const now = new Date("2026-08-30T10:00:00Z");
  const at = (offsetSeconds: number) =>
    String(Math.floor(now.getTime() / 1000) + offsetSeconds);

  it("accepts a timestamp inside the window, in both directions", () => {
    expect(isFreshAppEntryTimestamp(at(0), now)).toBe(true);
    expect(isFreshAppEntryTimestamp(at(-APP_ENTRY_MAX_AGE_SECONDS + 1), now)).toBe(true);
    // Clock skew can put Shopify slightly ahead of us.
    expect(isFreshAppEntryTimestamp(at(APP_ENTRY_MAX_AGE_SECONDS - 1), now)).toBe(true);
  });

  it("rejects stale and far-future timestamps", () => {
    expect(isFreshAppEntryTimestamp(at(-APP_ENTRY_MAX_AGE_SECONDS - 1), now)).toBe(false);
    expect(isFreshAppEntryTimestamp(at(APP_ENTRY_MAX_AGE_SECONDS + 1), now)).toBe(false);
  });

  it("rejects anything that is not a plain integer", () => {
    for (const bad of ["", "abc", "-100", "1.5", "1e9", undefined, null, ["1", "2"]]) {
      expect(isFreshAppEntryTimestamp(bad as unknown, now), String(bad)).toBe(false);
    }
  });
});

describe("verifyAppEntryHmac", () => {
  it("accepts a correctly signed, fresh request", () => {
    const r = verifyAppEntryHmac(entry(), SECRET);
    expect(r).toEqual({ ok: true, shop: SHOP });
  });

  it("signs over EVERY parameter Shopify sent, including ones we do not read", () => {
    // `host`, `embedded`, `session` and anything Shopify adds later are part
    // of the signed message. Dropping one would verify a different message.
    const q = entry({ embedded: "1", session: "abc123" });
    expect(verifyAppEntryHmac(q, SECRET).ok).toBe(true);
  });

  it("rejects an invalid HMAC", () => {
    const q = entry();
    q.hmac = q.hmac.replace(/^./, q.hmac[0] === "a" ? "b" : "a");
    expect(verifyAppEntryHmac(q, SECRET)).toEqual({ ok: false, reason: "hmac_invalid" });
  });

  it("rejects an HMAC signed with a different secret", () => {
    const base = { shop: SHOP, timestamp: String(Math.floor(Date.now() / 1000)) };
    const q = { ...base, hmac: sign(base, "some-other-app-secret") };
    expect(verifyAppEntryHmac(q, SECRET)).toEqual({ ok: false, reason: "hmac_invalid" });
  });

  it("rejects a missing HMAC", () => {
    const q = entry();
    delete (q as any).hmac;
    expect(verifyAppEntryHmac(q, SECRET)).toEqual({ ok: false, reason: "hmac_missing" });
  });

  it("rejects a tampered parameter even though the hmac is well-formed", () => {
    const q = entry();
    q.shop = "attacker-store.myshopify.com"; // signature was over the old shop
    expect(verifyAppEntryHmac(q, SECRET)).toEqual({ ok: false, reason: "hmac_invalid" });
  });

  it("rejects a stale timestamp", () => {
    const old = new Date(Date.now() - (APP_ENTRY_MAX_AGE_SECONDS + 60) * 1000);
    expect(verifyAppEntryHmac(entry({}, old), SECRET)).toEqual({
      ok: false,
      reason: "timestamp_stale",
    });
  });

  it("checks the signature BEFORE trusting the timestamp", () => {
    // A stale request with a broken signature must report the signature, not
    // the timestamp: the timestamp is attacker-chosen until the HMAC verifies.
    const old = new Date(Date.now() - (APP_ENTRY_MAX_AGE_SECONDS + 60) * 1000);
    const q = entry({}, old);
    q.hmac = "0".repeat(64);
    expect(verifyAppEntryHmac(q, SECRET)).toEqual({ ok: false, reason: "hmac_invalid" });
  });

  it("rejects a missing timestamp", () => {
    const base: Record<string, string> = { shop: SHOP };
    const q = { ...base, hmac: sign(base) };
    expect(verifyAppEntryHmac(q, SECRET)).toEqual({ ok: false, reason: "timestamp_missing" });
  });

  it("rejects a missing or deceptive shop before anything else", () => {
    const noShop = { timestamp: "1", hmac: "0".repeat(64) };
    expect(verifyAppEntryHmac(noShop, SECRET)).toEqual({ ok: false, reason: "shop_missing" });

    const badShop = { shop: "evil.com", timestamp: "1", hmac: "0".repeat(64) };
    expect(verifyAppEntryHmac(badShop, SECRET)).toEqual({ ok: false, reason: "shop_invalid" });
  });

  it("rejects DUPLICATED parameters", () => {
    // Express gives an array for ?shop=a&shop=b. Two different parsers could
    // disagree about which one is "the" shop; refusing removes the question.
    const q = entry();
    expect(verifyAppEntryHmac({ ...q, shop: [SHOP, "other.myshopify.com"] }, SECRET)).toEqual({
      ok: false,
      reason: "shop_invalid",
    });
    expect(verifyAppEntryHmac({ ...q, hmac: [q.hmac, q.hmac] }, SECRET)).toEqual({
      ok: false,
      reason: "hmac_missing",
    });
  });

  it("rejects a non-hex hmac without attempting a comparison", () => {
    const q = entry();
    expect(verifyAppEntryHmac({ ...q, hmac: "not-a-digest" }, SECRET)).toEqual({
      ok: false,
      reason: "hmac_invalid",
    });
  });

  it("fails closed when the app secret is not configured", () => {
    expect(verifyAppEntryHmac(entry(), "")).toEqual({ ok: false, reason: "not_configured" });
  });
});

describe("verifyOAuthCallbackHmac", () => {
  it("accepts a signed callback with no timestamp", () => {
    // Shopify does not always send `timestamp` on the callback. Requiring one
    // would reject legitimate callbacks; replay is closed by the single-use
    // state instead.
    const base = { shop: SHOP, code: "authcode123", state: "signedstate" };
    const q = { ...base, hmac: sign(base) };
    expect(verifyOAuthCallbackHmac(q, SECRET)).toEqual({ ok: true, shop: SHOP });
  });

  it("rejects an unsigned callback - the hole this closes", () => {
    // Before this change the callback read `shop` and `code` from an UNSIGNED
    // request. Anything able to present a live state could drive a token
    // exchange against a host of its choosing.
    const q = { shop: SHOP, code: "authcode123", state: "signedstate" };
    expect(verifyOAuthCallbackHmac(q, SECRET)).toEqual({ ok: false, reason: "hmac_missing" });
  });

  it("rejects a callback whose shop was swapped after signing", () => {
    const base = { shop: SHOP, code: "authcode123", state: "signedstate" };
    const q = { ...base, hmac: sign(base), shop: "attacker.myshopify.com" };
    expect(verifyOAuthCallbackHmac(q, SECRET)).toEqual({ ok: false, reason: "hmac_invalid" });
  });
});

describe("buildShopifyAuthorizeUrl", () => {
  const good = {
    shop: SHOP,
    clientId: "b1ce3aa50d8d2e67b978918629bc5f76",
    scopes: "read_orders,read_products",
    redirectUri: "https://app.gotcha.co.il/api/connectors/shopify/oauth/callback",
    state: "state-token",
  };

  it("builds an authorize URL on the shop's own host", () => {
    const url = buildShopifyAuthorizeUrl(good)!;
    const parsed = new URL(url);
    expect(parsed.origin).toBe(`https://${SHOP}`);
    expect(parsed.pathname).toBe("/admin/oauth/authorize");
    expect(parsed.searchParams.get("client_id")).toBe(good.clientId);
    expect(parsed.searchParams.get("state")).toBe(good.state);
    expect(parsed.searchParams.get("redirect_uri")).toBe(good.redirectUri);
  });

  it("REFUSES to build a redirect for a shop that is not canonical", () => {
    // Last line of defence: a caller that forgot to validate must fail closed
    // rather than emit an open redirect.
    for (const shop of ["evil.com", "evil.com/#", "shop.myshopify.com.evil.com", ""]) {
      expect(buildShopifyAuthorizeUrl({ ...good, shop }), shop).toBeNull();
    }
  });

  it("refuses when the app is not configured", () => {
    expect(buildShopifyAuthorizeUrl({ ...good, clientId: "" })).toBeNull();
    expect(buildShopifyAuthorizeUrl({ ...good, redirectUri: "" })).toBeNull();
    expect(buildShopifyAuthorizeUrl({ ...good, state: "" })).toBeNull();
  });
});

describe("resolveShopifyInstallUrl", () => {
  it("is null when nothing is configured - a real state, not a guess", () => {
    expect(resolveShopifyInstallUrl({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("derives the public listing from a handle read off the Partner Dashboard", () => {
    expect(resolveShopifyInstallUrl({ SHOPIFY_APP_HANDLE: "gotcha" } as NodeJS.ProcessEnv)).toBe(
      "https://apps.shopify.com/gotcha",
    );
  });

  it("prefers an explicit install URL - the only way to express a limited-visibility link", () => {
    const env = {
      SHOPIFY_APP_HANDLE: "gotcha",
      SHOPIFY_APP_INSTALL_URL: "https://admin.shopify.com/oauth/install_custom_app?client_id=abc",
    } as NodeJS.ProcessEnv;
    expect(resolveShopifyInstallUrl(env)).toContain("admin.shopify.com");
  });

  it("refuses an install URL that is not Shopify-owned", () => {
    // A misconfiguration here would turn the Connect button into an open
    // redirect carrying GOTCHA's name.
    for (const bad of [
      "https://evil.com/install",
      "http://apps.shopify.com/gotcha",
      "https://apps.shopify.com.evil.com/gotcha",
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect(
        resolveShopifyInstallUrl({ SHOPIFY_APP_INSTALL_URL: bad } as NodeJS.ProcessEnv),
        bad,
      ).toBeNull();
    }
  });

  it("refuses a malformed handle rather than building a 404", () => {
    for (const bad of ["", "  ", "Has Spaces", "-leading", "UPPER"]) {
      expect(
        resolveShopifyInstallUrl({ SHOPIFY_APP_HANDLE: bad } as NodeJS.ProcessEnv),
        bad,
      ).toBeNull();
    }
  });
});
