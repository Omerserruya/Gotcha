#!/usr/bin/env node
/**
 * Fail the build when a URL points at the wrong GOTCHA hostname.
 *
 * The migration moved the authenticated application to app.gotcha.co.il, and
 * the failure mode it guards against is not "someone typed the old domain" - it
 * is subtler than that. The marketing hostname `gotcha.co.il` remains valid and
 * in daily use for landing pages, so a plain grep for it is noise. What is
 * never valid is the MARKETING host serving an APPLICATION path: an OAuth
 * callback, a webhook, an API route. That combination is what this looks for.
 *
 * Two other classes are checked:
 *   - dev/staging hostnames committed outside an allowlisted config file, which
 *     is how a developer's tunnel ends up in a production manifest
 *   - `http://` against any gotcha.co.il host, which cannot be right in a
 *     committed file
 *
 * Deliberately NOT flagged: localhost, 127.0.0.1, and fixture/test URLs. A
 * check that fires on every local default gets suppressed, and a suppressed
 * check protects nothing.
 *
 * Usage:  node scripts/check-domains.mjs [--json]
 * Exit:   0 clean, 1 violations found, 2 could not run
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const MARKETING_HOST = "gotcha.co.il";
const APP_HOST = "app.gotcha.co.il";

/**
 * Path prefixes that belong to the APPLICATION. The marketing host must never
 * carry these. Derived from the repository's actual route tree, not invented.
 */
const APPLICATION_PATH_PREFIXES = [
  "/api/",
  "/auth/callback",
  "/cb",
  "/settings",
  "/ai-studio",
  "/inbox",
];

/** Non-production hostnames that must not appear outside their own config. */
const NONPROD_HOSTS = ["dev.gotcha.co.il", "auth-dev.gotcha.co.il", "staging.gotcha.co.il"];

/**
 * Files allowed to mention a non-production host, because describing the dev
 * environment is their job.
 */
const NONPROD_ALLOWLIST = [
  /^docker-compose\.yml$/,
  /^\.env(\.example)?$/,
  /^shopify-app\/shopify\.app\.dev\.toml$/,
  /^docs\//,
  /__tests__\//,
  /\.test\.[cm]?[jt]sx?$/,
  /^scripts\/check-domains\.mjs$/,
  // Screenshot and layout-verification tooling that drives the DEV storefront
  // on purpose. Pointing it at production would photograph a live merchant.
  /^scripts\/shopify\/(shoot-widget|verify-widget-layout)\.mjs$/,
  // The theme-editor help text tells a merchant how to point the widget at
  // GOTCHA's dev environment for testing. The dev hostname IS the instruction;
  // the shipped default above it is app.gotcha.co.il.
  /^shopify-app\/extensions\/gotcha-chat\/blocks\/gotcha_chat\.liquid$/,
];

/**
 * Files allowed to pair the marketing host with an application path, because
 * they exist to document or redirect the legacy arrangement.
 */
const COMPAT_ALLOWLIST = [
  /^docs\/migrations\//,
  /^scripts\/check-domains\.mjs$/,
  // The Shopify Chat manifest deliberately lists BOTH callback hosts while the
  // migration is in flight. `include_config_on_deploy = true` replaces the
  // allowlist on deploy, so dropping the old entry early breaks the OAuth of
  // any merchant mid-install. Remove this exemption together with that entry,
  // after the observation period.
  /^shopify-app\/shopify\.app\.toml$/,
];

const isAllowed = (file, patterns) => patterns.some((re) => re.test(file));

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\0").filter(Boolean);
}

const SKIP_EXT = /\.(png|jpe?g|gif|webp|svg|ico|pdf|woff2?|ttf|eot|mp4|zip|gz|lock)$/i;

function scan() {
  const violations = [];
  for (const file of trackedFiles()) {
    if (SKIP_EXT.test(file)) continue;
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue; // unreadable or binary
    }
    if (!text.includes(MARKETING_HOST)) continue;

    text.split("\n").forEach((line, i) => {
      const lineNo = i + 1;

      for (const m of line.matchAll(/https?:\/\/([a-z0-9.-]*gotcha\.co\.il)((?:\/[^\s"'`,)\]}]*)?)/gi)) {
        const [full, host, path = ""] = m;
        const lowerHost = host.toLowerCase();

        // An application path on the marketing host.
        if (lowerHost === MARKETING_HOST && APPLICATION_PATH_PREFIXES.some((p) => path.startsWith(p))) {
          if (!isAllowed(file, COMPAT_ALLOWLIST)) {
            violations.push({
              file, line: lineNo, found: full, rule: "marketing_host_serving_application_path",
              expected: `https://${APP_HOST}${path}`,
            });
          }
        }

        // A non-production host outside its own configuration.
        if (NONPROD_HOSTS.includes(lowerHost) && !isAllowed(file, NONPROD_ALLOWLIST)) {
          violations.push({
            file, line: lineNo, found: full, rule: "nonproduction_host_committed",
            expected: `https://${APP_HOST}${path} (or move this to dev-only config)`,
          });
        }

        // Plaintext against any of our hosts.
        if (full.toLowerCase().startsWith("http://") && !isAllowed(file, NONPROD_ALLOWLIST)) {
          violations.push({
            file, line: lineNo, found: full, rule: "insecure_scheme",
            expected: full.replace(/^http:/i, "https:"),
          });
        }
      }
    });
  }
  return violations;
}

let violations;
try {
  violations = scan();
} catch (err) {
  console.error(`[check-domains] could not run: ${err?.message ?? err}`);
  process.exit(2);
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ ok: violations.length === 0, violations }, null, 2));
} else if (violations.length === 0) {
  console.log("[check-domains] ok - no misplaced GOTCHA hostnames");
} else {
  console.error(`[check-domains] ${violations.length} violation(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    rule:     ${v.rule}`);
    console.error(`    found:    ${v.found}`);
    console.error(`    expected: ${v.expected}\n`);
  }
  console.error("If a hit is an intentional compatibility reference, add its path to the");
  console.error("allowlist in scripts/check-domains.mjs and say why in the commit.");
}

process.exit(violations.length === 0 ? 0 : 1);
