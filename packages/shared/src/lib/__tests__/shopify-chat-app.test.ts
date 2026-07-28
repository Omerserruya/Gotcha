/**
 * GOTCHA Shopify CHAT app — identity, verification and activation state.
 *
 * These are the checks that stand between an anonymous POST and a
 * merchant's storefront, so they are tested as adversarially as they are
 * written: forged signatures, near-miss shop domains, and the two handles
 * that have already been confused once in this codebase.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import {
  getShopifyChatAppConfig,
  validateChatAppConfig,
  normalizeShopifyShopDomain,
  normalizeStorefrontHost,
  verifyShopifyQueryHmac,
  verifyShopifyWebhookHmac,
  buildThemeEditorDeepLink,
  resolveChatActivationState,
  isServingState,
  HEARTBEAT_FRESH_MS,
} from "../shopify-chat-app";

const ENV_KEYS = [
  "SHOPIFY_CHAT_APP_CLIENT_ID",
  "SHOPIFY_CHAT_APP_SECRET",
  "SHOPIFY_CHAT_APP_URL",
  "SHOPIFY_CHAT_REDIRECT_URI",
  "SHOPIFY_CHAT_BLOCK_HANDLE",
  "SHOPIFY_API_KEY",
  "SHOPIFY_API_SECRET",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("chat app configuration", () => {
  it("defaults the block handle to the liquid file name, not the extension handle", () => {
    // gotcha_chat.liquid → "gotcha_chat". The extension is "gotcha-chat".
    // Getting this wrong opens the Theme Editor with nothing selected.
    expect(getShopifyChatAppConfig().blockHandle).toBe("gotcha_chat");
    expect(getShopifyChatAppConfig().extensionHandle).toBe("gotcha-chat");
  });

  it("reports every missing field rather than the first one", () => {
    const problems = validateChatAppConfig();
    const keys = problems.map((p) => p.key);
    expect(keys).toContain("SHOPIFY_CHAT_APP_CLIENT_ID");
    expect(keys).toContain("SHOPIFY_CHAT_APP_SECRET");
    expect(keys).toContain("SHOPIFY_CHAT_APP_URL");
    expect(keys).toContain("SHOPIFY_CHAT_REDIRECT_URI");
  });

  it("refuses a Chat client id that equals the Core app's", () => {
    process.env.SHOPIFY_CHAT_APP_CLIENT_ID = "same-id";
    process.env.SHOPIFY_API_KEY = "same-id";
    process.env.SHOPIFY_CHAT_APP_SECRET = "chat-secret";
    process.env.SHOPIFY_CHAT_APP_URL = "https://dev.gotcha.co.il";
    process.env.SHOPIFY_CHAT_REDIRECT_URI = "https://dev.gotcha.co.il/cb";
    const problems = validateChatAppConfig();
    expect(problems.some((p) => p.detail.includes("two different Partner apps"))).toBe(true);
  });

  it("refuses a Chat secret that equals the Core app's", () => {
    process.env.SHOPIFY_CHAT_APP_CLIENT_ID = "chat-id";
    process.env.SHOPIFY_CHAT_APP_SECRET = "shared-secret";
    process.env.SHOPIFY_API_SECRET = "shared-secret";
    process.env.SHOPIFY_CHAT_APP_URL = "https://dev.gotcha.co.il";
    process.env.SHOPIFY_CHAT_REDIRECT_URI = "https://dev.gotcha.co.il/cb";
    const problems = validateChatAppConfig();
    expect(problems.some((p) => p.key === "SHOPIFY_CHAT_APP_SECRET")).toBe(true);
  });
});

describe("shop domain normalization", () => {
  it("accepts the shapes merchants and Shopify actually send", () => {
    expect(normalizeShopifyShopDomain("my-store")).toBe("my-store.myshopify.com");
    expect(normalizeShopifyShopDomain("my-store.myshopify.com")).toBe("my-store.myshopify.com");
    expect(normalizeShopifyShopDomain("https://my-store.myshopify.com/admin/")).toBe(
      "my-store.myshopify.com",
    );
    expect(normalizeShopifyShopDomain("  MY-STORE.MyShopify.com ")).toBe("my-store.myshopify.com");
  });

  it("rejects the shapes that turn a shop parameter into a redirect target", () => {
    expect(normalizeShopifyShopDomain("evil.com")).toBeNull();
    expect(normalizeShopifyShopDomain("my-store.myshopify.com.evil.com")).toBeNull();
    expect(normalizeShopifyShopDomain("a.b.myshopify.com")).toBeNull();
    expect(normalizeShopifyShopDomain(".myshopify.com")).toBeNull();
    expect(normalizeShopifyShopDomain("")).toBeNull();
    expect(normalizeShopifyShopDomain(null)).toBeNull();
    expect(normalizeShopifyShopDomain(123 as any)).toBeNull();
  });

  it("normalizes storefront hosts without inventing a suffix", () => {
    expect(normalizeStorefrontHost("https://shop.example.com/collections")).toBe("shop.example.com");
    expect(normalizeStorefrontHost("shop.example.com:443")).toBe("shop.example.com");
    expect(normalizeStorefrontHost("not a host")).toBeNull();
    expect(normalizeStorefrontHost("localhost")).toBeNull();
  });
});

describe("Shopify query HMAC", () => {
  const secret = "chat-app-secret";

  function sign(params: Record<string, string>): string {
    const message = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join("&");
    return crypto.createHmac("sha256", secret).update(message).digest("hex");
  }

  it("accepts a genuine Shopify signature", () => {
    const params = { code: "abc", shop: "my-store.myshopify.com", state: "xyz", timestamp: "170" };
    const query = { ...params, hmac: sign(params) };
    expect(verifyShopifyQueryHmac(query, secret)).toBe(true);
  });

  it("rejects a tampered parameter", () => {
    const params = { code: "abc", shop: "my-store.myshopify.com", state: "xyz", timestamp: "170" };
    const query = { ...params, hmac: sign(params), shop: "attacker.myshopify.com" };
    expect(verifyShopifyQueryHmac(query, secret)).toBe(false);
  });

  it("rejects a signature made with the Core app's secret", () => {
    const params = { shop: "my-store.myshopify.com", timestamp: "170" };
    const message = "shop=my-store.myshopify.com&timestamp=170";
    const coreSigned = crypto.createHmac("sha256", "core-app-secret").update(message).digest("hex");
    expect(verifyShopifyQueryHmac({ ...params, hmac: coreSigned }, secret)).toBe(false);
  });

  it("rejects a missing signature and an empty secret", () => {
    expect(verifyShopifyQueryHmac({ shop: "x.myshopify.com" }, secret)).toBe(false);
    expect(verifyShopifyQueryHmac({ shop: "x.myshopify.com", hmac: "aa" }, "")).toBe(false);
  });
});

describe("Shopify webhook HMAC", () => {
  const secret = "chat-app-secret";
  const body = Buffer.from(JSON.stringify({ shop_domain: "my-store.myshopify.com" }));
  const good = crypto.createHmac("sha256", secret).update(body).digest("base64");

  it("verifies over the raw bytes", () => {
    expect(verifyShopifyWebhookHmac(body, good, secret)).toBe(true);
  });

  it("fails when the body is re-serialized", () => {
    // The reason raw-body capture exists: JSON.stringify(req.body) is not
    // byte-identical to what Shopify signed.
    const reserialized = Buffer.from(JSON.stringify({ shop_domain: "my-store.myshopify.com", extra: 1 }));
    expect(verifyShopifyWebhookHmac(reserialized, good, secret)).toBe(false);
  });

  it("rejects a wrong secret, a missing header and a missing body", () => {
    expect(verifyShopifyWebhookHmac(body, good, "core-app-secret")).toBe(false);
    expect(verifyShopifyWebhookHmac(body, undefined, secret)).toBe(false);
    expect(verifyShopifyWebhookHmac(undefined, good, secret)).toBe(false);
  });
});

describe("theme editor deep link", () => {
  it("targets the chat client id and the block handle", () => {
    const link = buildThemeEditorDeepLink({
      shopDomain: "my-store.myshopify.com",
      clientId: "chat-client-id",
      blockHandle: "gotcha_chat",
    });
    expect(link).toBe(
      "https://my-store.myshopify.com/admin/themes/current/editor?context=apps&activateAppId=chat-client-id%2Fgotcha_chat",
    );
  });

  it("returns null rather than a broken link when identity is missing", () => {
    expect(
      buildThemeEditorDeepLink({ shopDomain: "my-store.myshopify.com", clientId: "", blockHandle: "gotcha_chat" }),
    ).toBeNull();
    // A non-Shopify host can never become a deep link, even though a bare
    // slug ("my-store") legitimately normalizes to a myshopify domain.
    expect(
      buildThemeEditorDeepLink({ shopDomain: "evil.com", clientId: "id", blockHandle: "gotcha_chat" }),
    ).toBeNull();
    expect(
      buildThemeEditorDeepLink({ shopDomain: "my-store", clientId: "id", blockHandle: "gotcha_chat" }),
    ).toContain("https://my-store.myshopify.com/admin/themes/current/editor");
  });
});

describe("activation state", () => {
  const base = {
    installation: { status: "ACTIVE" as const, tenantId: "t1", channelAccountId: "c1" },
    channelExists: true,
    channelEnabled: true,
    tenantActive: true,
    chatEntitled: true,
    lastHeartbeatAt: new Date(),
    coreConnected: true,
  };

  it("is LIVE only when every condition holds", () => {
    expect(resolveChatActivationState(base)).toBe("LIVE");
  });

  it("walks the install lifecycle in order", () => {
    expect(resolveChatActivationState({ ...base, installation: null })).toBe("APP_NOT_INSTALLED");
    expect(
      resolveChatActivationState({ ...base, installation: { ...base.installation, status: "UNINSTALLED" } }),
    ).toBe("UNINSTALLED");
    expect(
      resolveChatActivationState({ ...base, installation: { ...base.installation, tenantId: null } }),
    ).toBe("INSTALLATION_UNBOUND");
    expect(resolveChatActivationState({ ...base, channelExists: false })).toBe("CHANNEL_NOT_CREATED");
    expect(resolveChatActivationState({ ...base, tenantActive: false })).toBe("TENANT_INACTIVE");
    expect(resolveChatActivationState({ ...base, chatEntitled: false })).toBe("ENTITLEMENT_DISABLED");
    expect(resolveChatActivationState({ ...base, channelEnabled: false })).toBe("EMBED_NOT_ENABLED");
  });

  it("distinguishes never-seen from gone-quiet", () => {
    expect(resolveChatActivationState({ ...base, lastHeartbeatAt: null })).toBe("EMBED_ENABLED_NOT_SEEN");
    const stale = new Date(Date.now() - HEARTBEAT_FRESH_MS - 60_000);
    expect(resolveChatActivationState({ ...base, lastHeartbeatAt: stale })).toBe("STALE");
  });

  it("says product chat is unavailable rather than pretending everything is fine", () => {
    expect(resolveChatActivationState({ ...base, coreConnected: false })).toBe(
      "CORE_DISCONNECTED_PRODUCT_CHAT_UNAVAILABLE",
    );
  });

  it("knows which states still serve shoppers", () => {
    expect(isServingState("LIVE")).toBe(true);
    expect(isServingState("STALE")).toBe(true);
    expect(isServingState("CORE_DISCONNECTED_PRODUCT_CHAT_UNAVAILABLE")).toBe(true);
    expect(isServingState("EMBED_NOT_ENABLED")).toBe(false);
    expect(isServingState("UNINSTALLED")).toBe(false);
    expect(isServingState("ENTITLEMENT_DISABLED")).toBe(false);
  });
});

describe("production refuses to run without a visitor-session secret", () => {
  it("throws rather than minting sessions with a default key", async () => {
    // Case 34. In dev there is a fallback so the stack boots; in
    // production a missing secret must stop the widget, not quietly make
    // every visitor session forgeable.
    const savedNode = process.env.NODE_ENV;
    const savedWidget = process.env.WIDGET_SESSION_SECRET;
    const savedJwt = process.env.JWT_SECRET;
    delete process.env.WIDGET_SESSION_SECRET;
    delete process.env.JWT_SECRET;
    (process.env as any).NODE_ENV = "production";
    try {
      const { signVisitorSession } = await import("../shopify-live-chat");
      expect(() =>
        signVisitorSession({
          tenantId: "t1",
          channelAccountId: "c1",
          visitorId: "v1",
          shopDomain: "my-store.myshopify.com",
        }),
      ).toThrow(/WIDGET_SESSION_SECRET/);
    } finally {
      (process.env as any).NODE_ENV = savedNode;
      if (savedWidget !== undefined) process.env.WIDGET_SESSION_SECRET = savedWidget;
      if (savedJwt !== undefined) process.env.JWT_SECRET = savedJwt;
    }
  });
});
