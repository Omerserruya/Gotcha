#!/usr/bin/env node
/**
 * Content-hash the storefront widget so a cache can never serve a stale
 * one.
 *
 * The bug this exists to make impossible: the Liquid carried a hand-typed
 * `?v=20260729`, four commits then changed the bundle without touching
 * it, and every browser that had already fetched that URL kept the old
 * code for the four hours of its max-age. Verification never caught it
 * because the test page invented a fresh `?v=` each run — a URL no cache
 * had ever seen.
 *
 * The shape that cannot rot:
 *
 *   bootstrap   stable URL, `no-cache` -> revalidated on every page load,
 *               304 when unchanged, so it is always current and costs
 *               almost nothing.
 *   chat bundle content-hashed filename, `immutable` -> cached forever,
 *               and a new build is a NEW URL by construction.
 *
 * The bootstrap carries the hashed bundle name baked in, so the pair can
 * never disagree: whichever bootstrap you have names the exact bundle it
 * was built against.
 *
 * Run: node scripts/widget/build-widget.mjs [--check]
 *   --check  verify the build output is current without writing (CI).
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const DIR = path.join(ROOT, "frontend/public/widget");
const BOOTSTRAP = path.join(DIR, "gotcha-shopify-bootstrap.js");
const CHAT_SRC = path.join(DIR, "gotcha-shopify-chat.js");
const MANIFEST = path.join(DIR, "widget-manifest.json");
const LIQUID = path.join(ROOT, "shopify-app/extensions/gotcha-chat/blocks/gotcha_chat.liquid");

const checkOnly = process.argv.includes("--check");

function hash(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 12);
}

const chatSource = fs.readFileSync(CHAT_SRC);
const chatHash = hash(chatSource);
const chatName = `gotcha-shopify-chat.${chatHash}.js`;

// The bootstrap names the bundle it was built against. Rewriting this
// constant is what ties the two halves together.
const MARKER = /var CHAT_BUNDLE = "[^"]*";/;
let bootstrapSource = fs.readFileSync(BOOTSTRAP, "utf8");
if (!MARKER.test(bootstrapSource)) {
  console.error(
    "✗ gotcha-shopify-bootstrap.js has no `var CHAT_BUNDLE = \"...\";` line.\n" +
      "  The build cannot tie the bootstrap to its bundle without it.",
  );
  process.exit(1);
}
const nextBootstrap = bootstrapSource.replace(MARKER, `var CHAT_BUNDLE = "${chatName}";`);
const bootstrapHash = hash(Buffer.from(nextBootstrap));

// The theme block names the exact bootstrap it was built against, for the
// same reason the bootstrap names its chat bundle.
//
// This is what makes the chain immune to caches we do not control: the
// edge in front of dev.gotcha.co.il rewrites the bootstrap's `no-cache`
// to `max-age=14400` regardless of what the origin sends, so a stable
// bootstrap URL can be four hours stale in a shopper's browser with
// nothing we can do about it. A content-addressed URL cannot be stale,
// because new bytes are a new URL.
const LIQUID_MARKER = /gotcha-shopify-bootstrap\.js\?b=[0-9a-f]{12}|gotcha-shopify-bootstrap\.js\?b=BOOTSTRAP_HASH/;
let liquidSource = fs.readFileSync(LIQUID, "utf8");
if (!LIQUID_MARKER.test(liquidSource)) {
  console.error(
    "✗ gotcha_chat.liquid does not reference the bootstrap with a `?b=` stamp.\n" +
      "  Without it the theme can serve a cached bootstrap indefinitely.",
  );
  process.exit(1);
}
const nextLiquid = liquidSource.replace(
  LIQUID_MARKER,
  `gotcha-shopify-bootstrap.js?b=${bootstrapHash}`,
);

const manifest = {
  chat: chatName,
  chatHash,
  bootstrapHash,
  // Deliberately no timestamp: a rebuild with identical bytes must produce
  // an identical manifest, or `--check` becomes noise in CI.
};

if (checkOnly) {
  const problems = [];
  if (nextBootstrap !== bootstrapSource) problems.push("bootstrap does not reference the current chat bundle hash");
  if (!fs.existsSync(path.join(DIR, chatName))) problems.push(`missing hashed bundle ${chatName}`);
  const onDisk = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, "utf8")) : null;
  if (!onDisk || onDisk.chat !== chatName) problems.push("widget-manifest.json is stale");
  if (nextLiquid !== liquidSource) problems.push("the theme block does not reference the current bootstrap hash");
  if (problems.length) {
    console.error("✗ widget build is out of date:");
    for (const p of problems) console.error("   • " + p);
    console.error("\n  Run: node scripts/widget/build-widget.mjs");
    process.exit(1);
  }
  console.log(`✓ widget build current (chat ${chatName})`);
  process.exit(0);
}

// Drop previous hashed bundles so the directory does not grow forever.
for (const f of fs.readdirSync(DIR)) {
  if (/^gotcha-shopify-chat\.[0-9a-f]{12}\.js$/.test(f) && f !== chatName) {
    fs.unlinkSync(path.join(DIR, f));
  }
}

fs.writeFileSync(path.join(DIR, chatName), chatSource);
fs.writeFileSync(BOOTSTRAP, nextBootstrap);
fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
fs.writeFileSync(LIQUID, nextLiquid);

console.log(`✓ chat bundle   ${chatName}`);
console.log(`✓ bootstrap     references it (hash ${bootstrapHash})`);
console.log(`✓ manifest      ${path.relative(ROOT, MANIFEST)}`);
console.log(`✓ theme block   loads bootstrap?b=${bootstrapHash}`);
