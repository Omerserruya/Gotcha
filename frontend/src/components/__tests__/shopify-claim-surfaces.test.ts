/**
 * EVERY screen that claims Shopify is live must read the paid-access gate.
 *
 * WHY THIS EXISTS
 * The first fix wired the three integration screens and shipped. It missed two
 * more: the business-systems status strip still read "writeback: enabled" and
 * the customer-system-of-record card still drew green capability chips, both
 * beside a banner saying the Connector was cancelled. They were missed because
 * the earlier tests pinned the components I already knew about, which is no
 * defence against the one I did not.
 *
 * So this test does not check behaviour. It checks COVERAGE: it finds every
 * frontend file that makes a Shopify-specific liveness claim and fails if any
 * of them does not consume the gate. A sixth surface added tomorrow fails here
 * on the day it is written, naming itself.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const SRC = join(process.cwd(), "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return e === "__tests__" ? [] : walk(p);
    return /\.tsx?$/.test(p) ? [p] : [];
  });
}

/**
 * Not claim surfaces. Each exclusion is a decision with a reason, because the
 * easy way to make this test pass is to keep adding names here.
 */
const NOT_CLAIM_SURFACES = [
  // The gate itself and the module that decides.
  "lib/useShopifyFeatureAccess.ts",
  "lib/shopify-connector-state.ts",
  // The API client: type declarations and fetch wrappers. It renders nothing,
  // so it cannot claim anything.
  "lib/api.ts",
  // The post-billing landing page. It reads `grantsAccess` straight from the
  // server response to decide where to send the merchant, which IS the gate's
  // own source rather than a second opinion about it.
  "app/integrations/shopify/billing/complete/page.tsx",
];

/**
 * A file makes a Shopify liveness claim if it mentions Shopify AND renders
 * something that asserts a capability is on. Billing screens are included
 * deliberately: they are the loudest claim of all.
 */
function claimsShopifyIsLive(text: string): boolean {
  const mentionsShopify = /shopify/i.test(text);
  if (!mentionsShopify) return false;
  return (
    /systemOfRecordActive|writesEnabled|toolsEnabled|availableTools/.test(text) ||
    /useAsCrm/.test(text) ||
    /grantsAccess/.test(text)
  );
}

const CONSUMES_GATE = /useShopifyFeatureAccess|presentShopifyFeatureAccess|presentConnector/;

describe("no Shopify surface claims access without asking the gate", () => {
  const offenders: string[] = [];
  const covered: string[] = [];

  for (const file of walk(SRC)) {
    const rel = file.slice(SRC.length + 1);
    if (NOT_CLAIM_SURFACES.includes(rel)) continue;
    const text = readFileSync(file, "utf8");
    if (!claimsShopifyIsLive(text)) continue;
    (CONSUMES_GATE.test(text) ? covered : offenders).push(rel);
  }

  it("every claim surface consumes the gate", () => {
    // If this fails it names the file. Either wire the gate into it, or, if it
    // genuinely makes no liveness claim, narrow claimsShopifyIsLive - but do
    // that deliberately, not to make a red test green.
    expect(offenders).toEqual([]);
  });

  it("finds the surfaces we already fixed, so the scan is not vacuous", () => {
    // A detector that matches nothing would pass the test above forever.
    for (const expected of [
      "components/IntegrationDetail.tsx",
      "components/IntegrationDrawer.tsx",
      "components/IntegrationsExplorer.tsx",
      "components/CustomerSystemOfRecordCard.tsx",
      "app/settings/business-systems/page.tsx",
      "app/ai-studio/marketplace/[slug]/page.tsx",
    ]) {
      expect(covered).toContain(expected);
    }
  });
});
