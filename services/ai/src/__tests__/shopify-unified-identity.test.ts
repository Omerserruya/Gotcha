/**
 * The unified Shopify app identity.
 *
 * GOTCHA ran two Partner apps. Core held the Admin token and every commerce
 * scope; Chat owned the Theme App Extension and had its own client id and
 * secret. The split was justified by scope minimization, but the Chat app
 * ended up declaring `scopes = ""` and holding no Admin token, leaving
 * nothing to minimize and two identities to keep in step.
 *
 * These tests pin the two properties that matter after unification:
 *
 *   1. Runtime verification derives its secret from the CORE app, and the
 *      Chat variables are not consulted at all. Aliasing them to the same
 *      value would leave two names for one secret, and the first rotation
 *      that missed one would break app-proxy verification with a signature
 *      error that reads like a misconfigured proxy.
 *
 *   2. Missing configuration FAILS CLOSED. An unset secret must refuse every
 *      request rather than accept unsigned ones.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getShopifyAppIdentity, validateAppIdentity, isAppIdentityConfigured } from "@chatcenter/shared";
import { verifyAppProxySignature } from "@chatcenter/shared";
import crypto from "crypto";

const SAVED = { ...process.env };

beforeEach(() => {
  for (const k of [
    "SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "SHOPIFY_APP_URL", "SHOPIFY_REDIRECT_URI",
    "SHOPIFY_APP_HANDLE", "SHOPIFY_CHAT_APP_CLIENT_ID", "SHOPIFY_CHAT_APP_SECRET",
    "SHOPIFY_CHAT_EXTENSION_HANDLE", "SHOPIFY_CHAT_BLOCK_HANDLE",
  ]) delete process.env[k];
});
afterEach(() => { process.env = { ...SAVED }; });

describe("getShopifyAppIdentity", () => {
  it("reads the CORE credentials", () => {
    process.env.SHOPIFY_API_KEY = "core-client";
    process.env.SHOPIFY_API_SECRET = "core-secret";
    const id = getShopifyAppIdentity();
    expect(id.clientId).toBe("core-client");
    expect(id.clientSecret).toBe("core-secret");
  });

  it("ignores the retired Chat variables entirely", () => {
    // The whole point of replacing rather than aliasing: if these were still
    // read, a half-completed rotation would silently keep working here and
    // fail somewhere else.
    process.env.SHOPIFY_CHAT_APP_CLIENT_ID = "chat-client";
    process.env.SHOPIFY_CHAT_APP_SECRET = "chat-secret";
    const id = getShopifyAppIdentity();
    expect(id.clientId).toBe("");
    expect(id.clientSecret).toBe("");
  });

  it("derives the app URL from the OAuth callback so the two cannot disagree", () => {
    process.env.SHOPIFY_REDIRECT_URI = "https://app.gotcha.co.il/api/connectors/shopify/oauth/callback";
    expect(getShopifyAppIdentity().appUrl).toBe("https://app.gotcha.co.il");
  });

  it("prefers an explicit app URL and strips trailing slashes", () => {
    process.env.SHOPIFY_APP_URL = "https://app.gotcha.co.il/";
    process.env.SHOPIFY_REDIRECT_URI = "https://elsewhere.example/cb";
    expect(getShopifyAppIdentity().appUrl).toBe("https://app.gotcha.co.il");
  });

  it("survives a malformed callback rather than throwing at import time", () => {
    process.env.SHOPIFY_REDIRECT_URI = "not-a-url";
    expect(getShopifyAppIdentity().appUrl).toBe("");
  });

  it("leaves the app handle EMPTY rather than guessing", () => {
    // A guessed handle produces an admin deep link that 404s for the
    // merchant, which is worse than offering no link.
    expect(getShopifyAppIdentity().appHandle).toBe("");
  });

  it("keeps the extension and block handles distinct", () => {
    // The block handle is the .liquid filename; the Theme Editor deep link
    // wants the BLOCK. Conflating them opens the editor with nothing
    // selected, which reads as a broken link.
    const id = getShopifyAppIdentity();
    expect(id.extensionHandle).toBe("gotcha-chat");
    expect(id.blockHandle).toBe("gotcha_chat");
    expect(id.extensionHandle).not.toBe(id.blockHandle);
  });
});

describe("validateAppIdentity - fails closed", () => {
  it("names the missing secret, because an unset one refuses every request", () => {
    process.env.SHOPIFY_API_KEY = "core-client";
    process.env.SHOPIFY_APP_URL = "https://app.gotcha.co.il";
    const problems = validateAppIdentity();
    expect(problems.map((p) => p.key)).toContain("SHOPIFY_API_SECRET");
    expect(isAppIdentityConfigured()).toBe(false);
  });

  it("passes when the core identity is complete", () => {
    process.env.SHOPIFY_API_KEY = "core-client";
    process.env.SHOPIFY_API_SECRET = "core-secret";
    process.env.SHOPIFY_APP_URL = "https://app.gotcha.co.il";
    expect(validateAppIdentity()).toEqual([]);
    expect(isAppIdentityConfigured()).toBe(true);
  });
});

describe("app-proxy verification under the unified secret", () => {
  /** Shopify's proxy scheme: hex HMAC over sorted params joined with NOTHING. */
  function sign(query: Record<string, string>, secret: string): string {
    const msg = Object.keys(query).sort().map((k) => `${k}=${query[k]}`).join("");
    return crypto.createHmac("sha256", secret).update(msg, "utf8").digest("hex");
  }

  it("accepts a request signed with the CORE secret", () => {
    const q: Record<string, string> = { shop: "s.myshopify.com", logged_in_customer_id: "42", timestamp: "1" };
    const signed = { ...q, signature: sign(q, "core-secret") };
    expect(verifyAppProxySignature(signed, "core-secret")).toBe(true);
  });

  it("rejects one signed with the retired Chat secret", () => {
    // This is the cutover's failure mode made explicit: after the switch, a
    // request signed by the old app must NOT verify.
    const q: Record<string, string> = { shop: "s.myshopify.com", timestamp: "1" };
    const signed = { ...q, signature: sign(q, "chat-secret") };
    expect(verifyAppProxySignature(signed, "core-secret")).toBe(false);
  });

  it("refuses everything when the secret is empty", () => {
    const q: Record<string, string> = { shop: "s.myshopify.com", timestamp: "1" };
    expect(verifyAppProxySignature({ ...q, signature: sign(q, "") }, "")).toBe(false);
  });

  it("refuses a request carrying no signature at all", () => {
    expect(verifyAppProxySignature({ shop: "s.myshopify.com" }, "core-secret")).toBe(false);
  });
});
