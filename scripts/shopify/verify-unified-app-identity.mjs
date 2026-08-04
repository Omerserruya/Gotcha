#!/usr/bin/env node
/**
 * Deployment safety check for the UNIFIED GOTCHA Shopify app.
 *
 * Run BEFORE every `shopify app` command:
 *
 *     node scripts/shopify/verify-unified-app-identity.mjs [--config shopify.app.production.toml]
 *
 * This replaces verify-chat-app-identity.mjs, whose central assertion was
 * "the linked client id must DIFFER from Core". That was correct for the
 * two-app architecture and is exactly wrong for this one: here the target
 * IS the Core app, and the danger inverts. We are no longer protecting Core
 * from being overwritten by a chat manifest; we are protecting Core from
 * being overwritten by an INCOMPLETE version of its own manifest.
 *
 * The failure this exists to prevent: `include_config_on_deploy = true`
 * makes this repo's TOML authoritative over the live app. A scope missing
 * from the file is a scope REMOVED from the app, and every connected
 * merchant then has to re-consent. There is no undo and no partial restore.
 *
 * Prints identity, never secrets. Exit 0 = safe to proceed.
 *
 * There is deliberately NO --force and NO bypass. If this refuses, the
 * answer is to fix the configuration, not to overrule the check.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const APP_DIR = path.join(ROOT, "shopify-app");

const args = process.argv.slice(2);
if (args.includes("--force") || args.includes("-f")) {
  console.error("\n  ✗ --force is not supported. This check has no bypass by design.\n");
  process.exit(2);
}
const configArgIdx = args.indexOf("--config");
const configName = configArgIdx >= 0 ? args[configArgIdx + 1] : "shopify.app.production.toml";
const configPath = path.join(APP_DIR, configName);

/** The one app every merchant connects through. */
const CORE_CLIENT_ID = "b1ce3aa50d8d2e67b978918629bc5f76";
/** Must never be the deploy target: it is bound to dev.gotcha.co.il. */
const CHAT_DEV_CLIENT_ID = "96c9417a8e0b8b7ea17b8c9bf7f4c3ad";

/**
 * The approved 26. Order is irrelevant; membership is not.
 *
 * Compared as a SET. Shopify's own read-back collapses `read_X` into a
 * granted `write_X`, so a human copying the API response back into the
 * manifest would silently delete six scopes. Comparing sets both ways
 * catches that in either direction.
 */
const REQUIRED_SCOPES = [
  "read_all_orders",
  "read_assigned_fulfillment_orders",
  "read_customers",
  "write_customers",
  "read_price_rules",
  "write_price_rules",
  "read_discounts",
  "write_discounts",
  "read_draft_orders",
  "read_fulfillments",
  "read_inventory",
  "read_inventory_shipments",
  "read_inventory_shipments_received_items",
  "read_inventory_transfers",
  "read_merchant_managed_fulfillment_orders",
  "write_merchant_managed_fulfillment_orders",
  "write_order_edits",
  "read_order_edits",
  "read_orders",
  "write_orders",
  "read_product_feeds",
  "read_product_listings",
  "read_products",
  "read_returns",
  "write_returns",
  "read_third_party_fulfillment_orders",
];

const PROD_HOST = "app.gotcha.co.il";
const PROD_APP_URL = `https://${PROD_HOST}`;
const PROD_CALLBACK = `${PROD_APP_URL}/api/connectors/shopify/oauth/callback`;
const PROD_PROXY_URL = `${PROD_APP_URL}/api/shopify-chat/proxy`;
const REQUIRED_WEBHOOK_PATHS = [
  "/api/connectors/shopify/webhooks/app-uninstalled",
  "/api/connectors/shopify/webhooks/customers-data-request",
  "/api/connectors/shopify/webhooks/customers-redact",
  "/api/connectors/shopify/webhooks/shop-redact",
];

const problems = [];
const notes = [];
const fail = (m) => problems.push(m);

/** Last four characters only: enough to compare, useless if leaked. */
const suffix = (v) => (v ? `…${String(v).slice(-4)}` : "(unset)");

// ─── Load env without printing it ────────────────────────────

function loadEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

const env = { ...loadEnvFile(path.join(ROOT, ".env.prod")), ...process.env };

// ─── Parse the manifest ──────────────────────────────────────

if (!fs.existsSync(configPath)) {
  console.error(`✗ Config not found: ${configPath}`);
  process.exit(1);
}
const toml = fs.readFileSync(configPath, "utf8");
/**
 * Comment-free view for the "must not contain" checks. These manifests
 * deliberately NAME the hosts that must never appear, so scanning raw text
 * would flag the very warning that exists to prevent the mistake.
 */
const code = toml
  .split("\n")
  .filter((l) => !l.trim().startsWith("#"))
  .join("\n");

const scalar = (key) => (code.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m")) ?? [])[1] ?? null;

const manifest = {
  clientId: scalar("client_id"),
  name: scalar("name"),
  handle: scalar("handle"),
  applicationUrl: scalar("application_url"),
  scopes: scalar("scopes"),
  proxyUrl: null,
  embedded: /^\s*embedded\s*=\s*true/m.test(code),
  apiVersion: scalar("api_version"),
  includeConfigOnDeploy: /^\s*include_config_on_deploy\s*=\s*true/m.test(code),
};

// app_proxy.url must be read from inside its own section: `url` also appears
// as a bare key elsewhere, and grabbing the first match picks the wrong one.
const proxySection = code.split(/^\s*\[app_proxy\]\s*$/m)[1];
if (proxySection) {
  manifest.proxyUrl = (proxySection.match(/^\s*url\s*=\s*"([^"]+)"/m) ?? [])[1] ?? null;
  manifest.proxySubpath = (proxySection.match(/^\s*subpath\s*=\s*"([^"]+)"/m) ?? [])[1] ?? null;
  manifest.proxyPrefix = (proxySection.match(/^\s*prefix\s*=\s*"([^"]+)"/m) ?? [])[1] ?? null;
}

const redirectUrls = [...code.matchAll(/"(https:\/\/[^"]*oauth\/callback)"/g)].map((m) => m[1]);
const webhookUris = [
  ...[...code.matchAll(/uri\s*=\s*"([^"]+)"/g)].map((m) => m[1]),
  ...[...code.matchAll(/^\s*\w+_url\s*=\s*"([^"]+)"/gm)].map((m) => m[1]),
];
const allUrls = [
  manifest.applicationUrl,
  manifest.proxyUrl,
  ...redirectUrls,
  ...webhookUris,
].filter(Boolean);

const extDir = path.join(APP_DIR, "extensions", "gotcha-chat");
const extToml = path.join(extDir, "shopify.extension.toml");
const extensionHandle = fs.existsSync(extToml)
  ? (fs.readFileSync(extToml, "utf8").match(/^\s*handle\s*=\s*"([^"]+)"/m) ?? [])[1] ?? null
  : null;
const blocksDir = path.join(extDir, "blocks");
const blockHandle = fs.existsSync(blocksDir)
  ? (fs.readdirSync(blocksDir)[0] ?? "").replace(/\.liquid$/, "") || null
  : null;

// ─── Checks ──────────────────────────────────────────────────

// 1 + 2. Identity.
if (!manifest.clientId) {
  fail("Manifest has no client_id. Refusing: a deploy would target whatever the CLI last linked.");
} else if (manifest.clientId !== CORE_CLIENT_ID) {
  fail(`client_id ${suffix(manifest.clientId)} is NOT the GOTCHA production app (${suffix(CORE_CLIENT_ID)}).`);
}
if (manifest.clientId && manifest.clientId === CHAT_DEV_CLIENT_ID) {
  fail("client_id is the GOTCHA Chat (Dev) app. That app is bound to dev.gotcha.co.il and must never receive production config.");
}
const envCore = env.SHOPIFY_API_KEY || "";
if (envCore && manifest.clientId && envCore !== manifest.clientId) {
  fail(`Manifest client_id ${suffix(manifest.clientId)} disagrees with SHOPIFY_API_KEY ${suffix(envCore)} in .env.prod.`);
}

// 3. Name and handle must be REAL, not guessed. Unverified is a hard stop:
//    with include_config_on_deploy the wrong name is published to the live app.
const expectedName = env.SHOPIFY_APP_NAME || "";
const expectedHandle = env.SHOPIFY_APP_HANDLE || "";
if (!expectedName || !expectedHandle) {
  fail(
    "SHOPIFY_APP_NAME / SHOPIFY_APP_HANDLE are not set. Read the exact name and handle " +
      "from the Partner Dashboard and record them in .env.prod. They cannot be inferred: " +
      "no Shopify API maps a client id to an app name.",
  );
} else {
  if (manifest.name && manifest.name !== expectedName) {
    fail(`Manifest name "${manifest.name}" != dashboard name "${expectedName}".`);
  }
  if (manifest.handle && manifest.handle !== expectedHandle) {
    fail(`Manifest handle "${manifest.handle}" != dashboard handle "${expectedHandle}".`);
  }
  if (!manifest.name || !manifest.handle) {
    fail("Manifest is missing name/handle. Add them once the dashboard values are confirmed.");
  }
}

// 4 + 5. Scope set: exact, both directions.
const declared = (manifest.scopes ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const declaredSet = new Set(declared);
const requiredSet = new Set(REQUIRED_SCOPES);
const missing = REQUIRED_SCOPES.filter((s) => !declaredSet.has(s));
const extra = declared.filter((s) => !requiredSet.has(s));
if (missing.length) {
  fail(`Scope set is MISSING ${missing.length}: ${missing.join(", ")}. With config deploy on, each missing scope is REVOKED on the live app.`);
}
if (extra.length) {
  fail(`Scope set has ${extra.length} unapproved: ${extra.join(", ")}.`);
}
if (declared.length !== new Set(declared).size) {
  fail("Scope list contains duplicates.");
}

// 6. Application URL.
if (manifest.applicationUrl !== PROD_APP_URL) {
  fail(`application_url is "${manifest.applicationUrl}", expected "${PROD_APP_URL}".`);
}

// 7. Redirect allowlist. Every URL the live app needs must be present, because
//    this list REPLACES the live one.
if (!redirectUrls.includes(PROD_CALLBACK)) {
  fail(`redirect_urls must contain the Core OAuth callback ${PROD_CALLBACK}.`);
}
const envRedirect = env.SHOPIFY_REDIRECT_URI || "";
if (envRedirect && !redirectUrls.includes(envRedirect)) {
  fail(`SHOPIFY_REDIRECT_URI (${envRedirect}) is not in redirect_urls. OAuth would break on deploy.`);
}

// 8. App proxy.
if (manifest.proxyUrl !== PROD_PROXY_URL) {
  fail(`app_proxy.url is "${manifest.proxyUrl}", expected "${PROD_PROXY_URL}".`);
}
if (manifest.proxySubpath !== "gotcha-chat" || manifest.proxyPrefix !== "apps") {
  fail(`app_proxy path must be /apps/gotcha-chat (got prefix="${manifest.proxyPrefix}" subpath="${manifest.proxySubpath}").`);
}

// 9. Webhooks.
for (const p of REQUIRED_WEBHOOK_PATHS) {
  if (!webhookUris.some((u) => u.endsWith(p))) fail(`Missing required webhook endpoint: ${p}`);
}

// 10. Chat extension present under this app.
if (!fs.existsSync(extToml)) {
  fail("Chat Theme App Extension not found at shopify-app/extensions/gotcha-chat/.");
} else if (extensionHandle !== "gotcha-chat") {
  fail(`Extension handle is "${extensionHandle}", expected "gotcha-chat".`);
}

// 11. No dev or localhost anywhere.
for (const u of allUrls) {
  if (/localhost|127\.0\.0\.1/i.test(u)) fail(`localhost URL in production manifest: ${u}`);
  if (/dev\.gotcha\.co\.il/i.test(u)) fail(`dev host in production manifest: ${u}`);
  if (/trycloudflare|ngrok|tunnel/i.test(u)) fail(`tunnel URL in production manifest: ${u}`);
  if (u.startsWith("http://")) fail(`non-HTTPS URL: ${u}`);
}

// 12. Embedded must stay false.
if (manifest.embedded) fail("embedded = true. GOTCHA's merchant UI is not an admin iframe.");

// Advisory: the flag that turns this from "ship an extension" into
// "republish the live app configuration".
if (manifest.includeConfigOnDeploy) {
  notes.push(
    "include_config_on_deploy = TRUE — this deploy WILL replace the live scope list and redirect allowlist.",
  );
} else {
  notes.push("include_config_on_deploy = false — extension-only deploy; live scopes and redirects are not touched.");
}

// ─── Report ──────────────────────────────────────────────────

console.log(`
  GOTCHA unified Shopify app — deployment identity check
  ─────────────────────────────────────────────────────
  config file        ${configName}
  linked client id   ${suffix(manifest.clientId)}
  expected (core)    ${suffix(CORE_CLIENT_ID)}  ← must MATCH
  chat dev id        ${suffix(CHAT_DEV_CLIENT_ID)}  ← must differ
  app name           ${manifest.name ?? "(absent)"}${expectedName ? "" : "   [dashboard value unknown]"}
  app handle         ${manifest.handle ?? "(absent)"}
  application url    ${manifest.applicationUrl ?? "(unset)"}
  redirect urls      ${redirectUrls.join("\n                     ") || "(none)"}
  app proxy          ${manifest.proxyUrl ?? "(unset)"}  (/${manifest.proxyPrefix}/${manifest.proxySubpath})
  scopes declared    ${declared.length} / ${REQUIRED_SCOPES.length} required
  webhook api        ${manifest.apiVersion ?? "(unset)"}
  extension handle   ${extensionHandle ?? "(absent)"}
  app embed block    ${blockHandle ?? "(absent)"}
  embedded           ${manifest.embedded}
`);
for (const n of notes) console.log(`  ⚠  ${n}`);

if (problems.length) {
  console.error("\n  ✗ REFUSING TO PROCEED\n");
  for (const p of problems) console.error(`    • ${p}`);
  console.error("\n  No bypass exists. Fix the configuration.\n");
  process.exit(1);
}

console.log("\n  ✓ Identity verified. Safe to run Shopify CLI commands against this app.\n");
