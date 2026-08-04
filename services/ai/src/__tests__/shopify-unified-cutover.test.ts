/**
 * Cutover invariants: one Shopify app, asserted against the SOURCE.
 *
 * The behavioural tests for enable/disable/uninstall live in
 * shopify-chat-install.test.ts and shopify-webhooks.test.ts. This file
 * guards the things a behavioural test cannot see: that the second identity
 * is gone from the code and the configuration, and stays gone.
 *
 * Structural assertions are used deliberately here. "The production runtime
 * does not read SHOPIFY_CHAT_APP_SECRET" is a property of the source, not of
 * any single request, and mocking a request to prove it would only prove the
 * mock. Reading the files is the honest test, and it fails the moment
 * somebody helpfully reintroduces the variable.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "../../../..");
const AI_SRC = path.join(REPO, "services/ai/src");

const CORE_CLIENT_ID = "b1ce3aa50d8d2e67b978918629bc5f76";
const CHAT_DEV_CLIENT_ID = "96c9417a8e0b8b7ea17b8c9bf7f4c3ad";

const read = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");

/** Every .ts under services/ai/src that is not a test. */
function runtimeSources(dir = AI_SRC, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      runtimeSources(full, acc);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

describe("the retired Chat identity is gone from the runtime", () => {
  it("no runtime source reads SHOPIFY_CHAT_APP_CLIENT_ID or _SECRET", () => {
    const offenders = runtimeSources()
      .filter((f) => /SHOPIFY_CHAT_APP_(CLIENT_ID|SECRET)/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(REPO, f));
    expect(offenders).toEqual([]);
  });

  it("no runtime source calls getShopifyChatAppConfig", () => {
    const offenders = runtimeSources()
      .filter((f) => /getShopifyChatAppConfig\s*\(/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(REPO, f));
    expect(offenders).toEqual([]);
  });

  it("neither compose file injects the retired variables", () => {
    // Removed rather than re-pointed at the Core values: two names for one
    // secret means the first rotation that misses one breaks app-proxy
    // verification with an error that reads like a misconfigured proxy.
    for (const f of ["docker-compose.yml", "docker-compose.prod.yml"]) {
      const declarations = read(f)
        .split("\n")
        .filter((l) => /^\s*SHOPIFY_CHAT_APP_(CLIENT_ID|SECRET)\s*:/.test(l));
      expect(declarations, `${f} still declares the retired vars`).toEqual([]);
    }
  });

  it("the Chat Dev client id appears in no runtime source", () => {
    const offenders = runtimeSources()
      .filter((f) => fs.readFileSync(f, "utf8").includes(CHAT_DEV_CLIENT_ID))
      .map((f) => path.relative(REPO, f));
    expect(offenders).toEqual([]);
  });
});

describe("app-proxy and webhooks verify with the CORE secret", () => {
  it("the proxy identity route derives its secret from the unified identity", () => {
    const src = read("services/ai/src/routes/shopify-chat-public.ts");
    expect(src).toMatch(/getShopifyAppIdentity\(\)/);
    expect(src).not.toMatch(/getShopifyChatAppConfig/);
  });

  it("every webhook handler verifies against the same core secret", () => {
    const src = read("services/ai/src/routes/shopify-webhooks.ts");
    // Chat-family routes moved onto the unified identity...
    expect(src).toMatch(/getShopifyAppIdentity\(\)\.clientSecret/);
    // ...and the commerce family still reads the core env var directly.
    expect(src).toMatch(/process\.env\.SHOPIFY_API_SECRET/);
    expect(src).not.toMatch(/getShopifyChatAppConfig/);
  });

  it("the unified identity module reads only the core env vars", () => {
    const src = read("packages/shared/src/lib/shopify-app-identity.ts");
    expect(src).toMatch(/process\.env\.SHOPIFY_API_KEY/);
    expect(src).toMatch(/process\.env\.SHOPIFY_API_SECRET/);
    expect(src).not.toMatch(/process\.env\.SHOPIFY_CHAT_APP_(CLIENT_ID|SECRET)/);
  });
});

describe("enabling Chat starts no OAuth", () => {
  const routeSrc = () => read("services/ai/src/routes/shopify-chat-install.ts");

  it("the install router mints and consumes no OAuth state", () => {
    const src = routeSrc();
    expect(src).not.toMatch(/mintOAuthState/);
    expect(src).not.toMatch(/consumeOAuthState/);
  });

  it("the install router declares no oauth routes at all", () => {
    // Comment-stripped: the file header legitimately NAMES the removed
    // routes while explaining why they are gone, and scanning raw text
    // would flag the very documentation that prevents their return.
    const code = routeSrc()
      .split("\n")
      .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*"))
      .join("\n");
    expect(code).not.toMatch(/oauth\/(init|callback)/);
  });

  it("enable never redirects the merchant to Shopify", () => {
    const src = routeSrc();
    expect(src).not.toMatch(/myshopify\.com\/admin\/oauth/);
    expect(src).not.toMatch(/res\.redirect/);
  });

  it("the shop is read from the Core connection, never from the request", () => {
    // Accepting a shop from the body would let a tenant claim a storefront
    // it never connected.
    const svc = read("services/ai/src/services/shopify-chat-install.service.ts");
    expect(svc).toMatch(/loadConnection\(\{\s*tenantId: input\.tenantId,\s*slug: "shopify"\s*\}\)/);
  });
});

describe("disable and uninstall preserve what they should", () => {
  const svc = () => read("services/ai/src/services/shopify-chat-install.service.ts");

  it("disabling Chat touches no TenantIntegration row", () => {
    // Extract the function body and prove it never reaches the connection.
    const src = svc();
    const start = src.indexOf("export async function disableChatForTenant");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\nexport ", start + 10));
    expect(body).not.toMatch(/tenantIntegration/);
    expect(body).toMatch(/channelAccount\.update/);
  });

  it("neither disable nor uninstall deletes conversations", () => {
    const src = svc();
    expect(src).not.toMatch(/conversation\.deleteMany|message\.deleteMany|auditLog\.deleteMany/);
  });

  it("core uninstall routes through the chat disable helper", () => {
    expect(read("services/ai/src/routes/shopify-webhooks.ts"))
      .toMatch(/disableChatForUninstalledShop\(/);
  });
});

describe("commerce still runs on the Core connection", () => {
  it("product truth is still read through the shopify integration", () => {
    // Unification must not have moved the widget's product source; cards and
    // Add-to-Cart validation continue to use the Core token. The slug comes
    // from a constant, so assert the call AND what the constant resolves to.
    const src = read("services/ai/src/services/shopify-catalog.service.ts");
    expect(src).toMatch(/loadConnection\(\{\s*tenantId,\s*slug: SHOPIFY_SLUG\s*\}\)/);
    expect(src).toMatch(/SHOPIFY_SLUG\s*=\s*"shopify"|SHOPIFY_SLUG\b.*from/);
  });

  it("the commerce adapter is unchanged in how it loads credentials", () => {
    expect(read("services/ai/src/services/commerce-context.service.ts"))
      .toMatch(/loadConnection/);
  });
});

describe("production configuration", () => {
  const toml = () => read("shopify-app/shopify.app.production.toml");

  it("targets the Core client id", () => {
    expect(toml()).toMatch(new RegExp(`client_id = "${CORE_CLIENT_ID}"`));
  });

  it("never names the Chat Dev app", () => {
    expect(toml()).not.toContain(CHAT_DEV_CLIENT_ID);
  });

  it("carries no include_config_on_deploy - the flag is obsolete", () => {
    // CLI 3.x removed it: `app deploy` prints "no longer supported" and
    // strips the field. Keeping it would imply a safety catch that does not
    // exist, which is worse than not having one, because it invites a deploy
    // that silently republishes scopes and redirect URLs.
    const active = toml().split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(active).not.toMatch(/include_config_on_deploy/);
    expect(active).not.toMatch(/^\s*\[build\]/m);
  });

  it("omits the handle rather than guessing it", () => {
    const active = toml().split("\n").filter((l) => !l.trim().startsWith("#"));
    expect(active.some((l) => /^\s*handle\s*=/.test(l))).toBe(false);
  });

  it("declares all 26 approved scopes", () => {
    const scopes = (toml().match(/^scopes = "([^"]+)"/m) ?? [])[1] ?? "";
    expect(scopes.split(",").filter(Boolean)).toHaveLength(26);
    expect(scopes).toContain("write_merchant_managed_fulfillment_orders");
  });

  it("never sends Shopify traffic to a dev or localhost ENDPOINT", () => {
    // Scoped to endpoints on purpose. `dev.gotcha.co.il` IS a legitimate
    // entry in the redirect allowlist - a live callback this rollout
    // preserves - but it must never be where Shopify SENDS traffic: not the
    // application URL, not the app proxy, not a webhook. Banning it outright
    // would force dropping a live redirect; allowing it outright would let a
    // dev host receive production webhooks.
    const active = toml().split("\n").filter((l) => !l.trim().startsWith("#"));
    const endpoints = active.filter((l) =>
      /^(application_url|url)\s*=/.test(l.trim()) || /_url\s*=|^\s*uri\s*=/.test(l),
    );
    expect(endpoints.length).toBeGreaterThan(0);
    for (const line of endpoints) {
      expect(line, `dev/localhost endpoint: ${line.trim()}`)
        .not.toMatch(/dev\.gotcha\.co\.il|localhost|127\.0\.0\.1/);
    }
    // localhost is banned everywhere, including redirects.
    expect(active.join("\n")).not.toMatch(/localhost|127\.0\.0\.1/);
  });

  it("preserves all three live redirect callbacks", () => {
    // The manifest REPLACES the live allowlist on deploy. Dropping one
    // silently breaks OAuth for anything still pointed at it.
    const t = toml();
    for (const host of ["app.gotcha.co.il", "gotcha.co.il", "dev.gotcha.co.il"]) {
      expect(t).toContain(`https://${host}/api/connectors/shopify/oauth/callback`);
    }
  });

  it("pins the webhook API version the app is LIVE on", () => {
    // 2026-04, not the repo's 2026-07 Admin pin. Re-versioning live
    // subscriptions is a separate, deliberate change.
    expect(toml()).toMatch(/api_version = "2026-04"/);
  });

  it("points the app proxy at the production endpoint", () => {
    const t = toml();
    expect(t).toMatch(/url = "https:\/\/app\.gotcha\.co\.il\/api\/shopify-chat\/proxy"/);
    expect(t).toMatch(/subpath = "gotcha-chat"/);
    expect(t).toMatch(/prefix = "apps"/);
  });
});

describe("the Theme Editor deep link targets the unified app", () => {
  it("is built from the identity module, not the retired chat config", () => {
    const src = read("services/ai/src/routes/shopify-live-chat.ts");
    expect(src).toMatch(/getShopifyAppIdentity\(\)/);
    expect(src).not.toMatch(/getShopifyChatAppConfig/);
  });

  it("uses the block handle, which is not the extension handle", () => {
    // The Theme Editor deep link wants the BLOCK (.liquid filename). Passing
    // the extension handle opens the editor with nothing selected, which
    // reads to a merchant as a broken link.
    const src = read("packages/shared/src/lib/shopify-app-identity.ts");
    expect(src).toMatch(/DEFAULT_EXTENSION_HANDLE = "gotcha-chat"/);
    expect(src).toMatch(/DEFAULT_BLOCK_HANDLE = "gotcha_chat"/);
  });
});
