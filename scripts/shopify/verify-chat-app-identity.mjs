#!/usr/bin/env node
/**
 * Deployment safety check for the GOTCHA Shopify CHAT app.
 *
 * Run BEFORE any `shopify app` command:
 *
 *     node scripts/shopify/verify-chat-app-identity.mjs [--config shopify.app.dev.toml]
 *
 * It exists because one mistake in this area is unrecoverable in practice:
 * the manifest sets `include_config_on_deploy = true`, so deploying it
 * against the CORE app's client id would replace the live commerce
 * connector's scopes and redirect allowlist and break OAuth for every
 * connected store.
 *
 * Prints identity, never secrets. Exit code 0 = safe to proceed.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const APP_DIR = path.join(ROOT, "shopify-app");

const args = process.argv.slice(2);
const configArgIdx = args.indexOf("--config");
const configName = configArgIdx >= 0 ? args[configArgIdx + 1] : "shopify.app.toml";
const configPath = path.join(APP_DIR, configName);

const problems = [];
const notes = [];

function fail(msg) {
  problems.push(msg);
}

/** Last four characters only — enough to compare, useless if leaked. */
function suffix(value) {
  if (!value) return "(unset)";
  return `…${String(value).slice(-4)}`;
}

// ─── Load env without printing it ────────────────────────────

function loadEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return out;
}

const isDev = configName.includes("dev");
const envFile = path.join(ROOT, isDev ? ".env" : ".env.prod");
const fileEnv = loadEnvFile(envFile);
const env = { ...fileEnv, ...process.env };

// ─── Parse the manifest (small, fixed shape — no TOML dependency) ──

if (!fs.existsSync(configPath)) {
  console.error(`✗ Config not found: ${configPath}`);
  process.exit(1);
}
const toml = fs.readFileSync(configPath, "utf8");
/**
 * Comment-free view, used for the "must not contain" checks. The comments
 * in these manifests deliberately NAME the things that must not appear
 * (the Core callback, the dead hosts), so scanning raw text would flag the
 * warning that exists to prevent the mistake.
 */
const tomlCode = toml
  .split("\n")
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n");

function scalar(key) {
  const m = tomlCode.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"));
  return m ? m[1] : null;
}

const manifest = {
  name: scalar("name"),
  handle: scalar("handle"),
  clientId: scalar("client_id"),
  applicationUrl: scalar("application_url"),
  scopes: scalar("scopes"),
  embedded: /^\s*embedded\s*=\s*true/m.test(tomlCode),
  apiVersion: scalar("api_version"),
};
const redirectUrls = [...tomlCode.matchAll(/"(https:\/\/[^"]*oauth\/callback)"/g)].map((m) => m[1]);
/**
 * Every webhook endpoint the manifest declares, from BOTH shapes:
 * ordinary `uri = "..."` subscriptions, and the mandatory privacy trio,
 * which Shopify requires under [webhooks.privacy_compliance] as
 * customer_data_request_url / customer_deletion_url / shop_deletion_url.
 * Declaring the privacy topics as ordinary subscriptions is rejected.
 */
const webhookUris = [
  ...[...tomlCode.matchAll(/uri\s*=\s*"([^"]+)"/g)].map((m) => m[1]),
  ...[...tomlCode.matchAll(/^\s*\w+_url\s*=\s*"([^"]+)"/gm)].map((m) => m[1]),
];
const extensionToml = path.join(APP_DIR, "extensions", "gotcha-chat", "shopify.extension.toml");
const extensionHandle = fs.existsSync(extensionToml)
  ? (fs.readFileSync(extensionToml, "utf8").match(/^\s*handle\s*=\s*"([^"]+)"/m) ?? [])[1] ?? null
  : null;
const blockFiles = fs.existsSync(path.join(APP_DIR, "extensions", "gotcha-chat", "blocks"))
  ? fs.readdirSync(path.join(APP_DIR, "extensions", "gotcha-chat", "blocks"))
  : [];
const blockHandle = blockFiles.length ? blockFiles[0].replace(/\.liquid$/, "") : null;

// ─── The checks that matter ──────────────────────────────────

const expectedClientId = env.SHOPIFY_CHAT_APP_CLIENT_ID || "";
const coreClientId = env.SHOPIFY_API_KEY || "";

if (!manifest.clientId) {
  fail(
    "Manifest has no client_id — the CLI project is not linked. Run `shopify app config link` " +
      "and choose the GOTCHA Chat app (NOT the Core app).",
  );
}
if (!expectedClientId) {
  fail(`SHOPIFY_CHAT_APP_CLIENT_ID is not set (looked in ${path.basename(envFile)} and the environment).`);
}
if (manifest.clientId && coreClientId && manifest.clientId === coreClientId) {
  fail(
    "MANIFEST IS LINKED TO THE CORE SHOPIFY APP. Deploying would overwrite the commerce " +
      "connector's scopes and redirect URLs. Re-link to the Chat app before doing anything else.",
  );
}
if (manifest.clientId && expectedClientId && manifest.clientId !== expectedClientId) {
  fail(
    `Linked client id ${suffix(manifest.clientId)} does not match SHOPIFY_CHAT_APP_CLIENT_ID ` +
      `${suffix(expectedClientId)}.`,
  );
}

// Core scopes must never appear in the Chat manifest.
const CORE_SCOPES = [
  "read_orders",
  "write_orders",
  "read_customers",
  "write_customers",
  "read_price_rules",
  "write_price_rules",
  "write_discounts",
  "read_returns",
];
const declaredScopes = (manifest.scopes || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const forbidden = declaredScopes.filter((s) => CORE_SCOPES.includes(s));
if (forbidden.length) {
  fail(`Chat manifest declares Core scopes: ${forbidden.join(", ")}. The Chat app must not request these.`);
}

// Core callback path must never appear.
if (tomlCode.includes("/api/connectors/shopify/oauth/callback")) {
  fail("Manifest contains the CORE OAuth callback path. Chat must use /api/connectors/shopify-chat/oauth/callback.");
}

// Dead hosts that have bitten this project before.
for (const dead of ["app.gotcha.co.il", "api.gotcha.co.il"]) {
  if (tomlCode.includes(dead)) fail(`Manifest references ${dead}, which does not resolve.`);
}

// One environment per config file.
const hosts = [...new Set([manifest.applicationUrl, ...redirectUrls, ...webhookUris]
  .filter(Boolean)
  .map((u) => new URL(u).host))];
if (hosts.length > 1) {
  fail(`Manifest mixes hosts: ${hosts.join(", ")}. One environment per config file.`);
}
const host = hosts[0] ?? "(none)";
if (isDev && host !== "dev.gotcha.co.il") {
  fail(`Dev config must point at dev.gotcha.co.il, found ${host}.`);
}
if (!isDev && host !== "gotcha.co.il") {
  fail(`Production config must point at gotcha.co.il, found ${host}.`);
}

// Redirect must match what the service will send.
const expectedRedirect = env.SHOPIFY_CHAT_REDIRECT_URI || "";
if (expectedRedirect && !redirectUrls.includes(expectedRedirect)) {
  fail(`SHOPIFY_CHAT_REDIRECT_URI (${expectedRedirect}) is not in the manifest's redirect_urls.`);
}

// Mandatory compliance topics for public distribution.
for (const required of ["customers-data-request", "customers-redact", "shop-redact", "app-uninstalled"]) {
  if (!webhookUris.some((u) => u.endsWith(required))) {
    fail(`Missing webhook subscription: ${required}.`);
  }
}

// The block handle the Theme Editor deep link will use.
const expectedBlock = env.SHOPIFY_CHAT_BLOCK_HANDLE || "gotcha_chat";
if (blockHandle && blockHandle !== expectedBlock) {
  fail(`App Embed block file is "${blockHandle}" but SHOPIFY_CHAT_BLOCK_HANDLE is "${expectedBlock}".`);
}
if (!env.SHOPIFY_CHAT_APP_SECRET) {
  notes.push("SHOPIFY_CHAT_APP_SECRET is not set — webhooks and OAuth callbacks will be refused at runtime.");
}
if (!isDev && !env.WIDGET_SESSION_SECRET) {
  fail("WIDGET_SESSION_SECRET is not set for production — visitor sessions cannot be minted and the widget cannot start.");
}

// ─── Report ──────────────────────────────────────────────────

console.log("");
console.log("  GOTCHA Shopify Chat — deployment identity check");
console.log("  ───────────────────────────────────────────────");
console.log(`  config file        ${configName}`);
console.log(`  environment        ${isDev ? "development" : "production"}`);
console.log(`  linked app name    ${manifest.name ?? "(none)"}`);
console.log(`  app handle         ${manifest.handle ?? "(none)"}`);
console.log(`  linked client id   ${suffix(manifest.clientId)}`);
console.log(`  expected chat id   ${suffix(expectedClientId)}`);
console.log(`  core client id     ${suffix(coreClientId)}  ← must differ`);
console.log(`  host               ${host}`);
console.log(`  application url    ${manifest.applicationUrl ?? "(none)"}`);
console.log(`  redirect urls      ${redirectUrls.join(", ") || "(none)"}`);
console.log(`  scopes             ${manifest.scopes === "" ? "(none — by design)" : manifest.scopes}`);
console.log(`  embedded           ${manifest.embedded}`);
console.log(`  webhook api        ${manifest.apiVersion ?? "(none)"}`);
console.log(`  extension handle   ${extensionHandle ?? "(none)"}`);
console.log(`  app embed block    ${blockHandle ?? "(none)"}`);
console.log("");

for (const n of notes) console.log(`  ⚠  ${n}`);
if (notes.length) console.log("");

if (problems.length) {
  console.error("  ✗ REFUSING TO PROCEED\n");
  for (const p of problems) console.error(`    • ${p}`);
  console.error("");
  process.exit(1);
}

console.log("  ✓ Identity verified. Safe to run Shopify CLI commands against this app.\n");
