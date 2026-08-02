/**
 * The Help Center describes the real product, or it is worse than nothing.
 *
 * A setup guide that names a hostname we do not serve sends a merchant to
 * configure their provider against a dead endpoint, and the failure surfaces
 * days later as "the integration does not work". The public Help Center's login
 * button pointed at the DEV host until this migration, so every visitor who
 * clicked it was sent to an environment they have no account on.
 *
 * These tests cover the two things text search cannot: that no article names a
 * non-production or application-serving-marketing host, and that the Shopify
 * article still states the limitations somebody has to read BEFORE they promise
 * a customer something the product cannot do.
 */
import { describe, it, expect } from "vitest";
import { integrations } from "../content/integrations";
import { channels } from "../content/channels";
import { account } from "../content/account";
import { billing } from "../content/billing";
import { gettingStarted } from "../content/getting-started";
import { aiEmployees } from "../content/ai-employees";
import { knowledge } from "../content/knowledge";

const CATEGORIES = [integrations, channels, account, billing, gettingStarted, aiEmployees, knowledge];
const ALL_TEXT = CATEGORIES.flatMap((c: any) => c.articles.flatMap((a: any) => a.body)).join("\n");

describe("no article sends anyone to the wrong host", () => {
  it("names no non-production GOTCHA hostname", () => {
    for (const host of ["dev.gotcha.co.il", "auth-dev.gotcha.co.il", "staging.gotcha.co.il"]) {
      expect(ALL_TEXT).not.toContain(host);
    }
  });

  it("never puts an application path on the marketing host", () => {
    // `gotcha.co.il` alone is legitimate - it is the marketing site. What is
    // never legitimate is the marketing host carrying /api/ or an app route.
    const paths = (ALL_TEXT.match(/https:\/\/gotcha\.co\.il\/[^\s"'`)\]]*/g) ?? [])
      .map((u) => u.replace("https://gotcha.co.il", ""));
    const offenders = paths.filter((p) =>
      ["/api/", "/settings", "/inbox", "/ai-studio", "/auth/callback"].some((x) => p.startsWith(x)));
    expect(offenders).toEqual([]);
  });

  it("uses no localhost URL", () => {
    expect(ALL_TEXT).not.toMatch(/localhost/i);
  });
});

describe("the Shopify article describes what the product actually does", () => {
  const article: any = (integrations as any).articles.find((a: any) => a.slug === "connect-shopify");
  const [en, he] = article.body as [string, string];

  it("exists in both languages", () => {
    expect(article.body).toHaveLength(2);
    expect(he).toMatch(/[֐-׿]/); // actually Hebrew, not English twice
  });

  it("states that money-moving actions wait for a human", () => {
    expect(en).toMatch(/approve/i);
  });

  it("states that a tool the operator disabled stays disabled after reconnect", () => {
    // The single most expensive thing to get wrong: an operator who reads
    // otherwise will re-enable a refund tool by reconnecting and not know it.
    expect(en).toMatch(/stay off|stays? disabled/i);
    expect(he).toMatch(/כבויים/);
  });

  it("names the unsupported capabilities rather than implying they work", () => {
    expect(en).toMatch(/not supported/i);
    for (const claim of [/[Cc]oupons/, /[Tt]ax invoices/, /[Aa]ddress changes/, /disconnected/i]) {
      expect(en).toMatch(claim);
    }
  });

  it("does not promise coupon creation in a customer conversation", () => {
    // Part 4 of the readiness work ruled coupons out of scope. An article that
    // implies otherwise sets a customer expectation the bot must then break.
    expect(en).toMatch(/does not create or validate them/i);
  });
});

describe("house style", () => {
  it("uses no em-dash or en-dash in customer-facing copy", () => {
    const found = ALL_TEXT.match(/.{0,40}[—–].{0,40}/g) ?? [];
    expect(found).toEqual([]);
  });
});
