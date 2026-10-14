/**
 * What a rescan writes to Knowledge must read like knowledge (2026-10-14, the
 * dev store's first rescan): one document per page, titled, without the
 * header and footer every page repeats; topics with no facts left out and
 * reported; contact channels in words, never raw slugs.
 */
import { describe, it, expect } from "vitest";
import { projectPages, projectDiscoveryTopics, hasConcreteFact, BOILERPLATE_MIN_PAGES, type SkippedTopic } from "../discovery-to-knowledge";

const CTX = { language: "he", now: "2026-10-14T09:00:00.000Z" };
const HEAD = "Skip to content Free shipping on orders over 299 · 30-day free returns Shop Women Men Accessories";
const FOOT = "Newsletter Sign up © 2026 HALVO All rights reserved Privacy Terms";
const page = (body: string) => `${HEAD} ${body} ${FOOT}`;

describe("★ one document per page", () => {
  it("the same content at two addresses is one document, at the canonical address", () => {
    const faq = page("Frequently asked questions about orders, sizing and delivery times in Israel.");
    const out = projectPages([
      { url: "https://shop.test/", content: page("Welcome to the shop, considered clothing designed in Copenhagen."), home: true },
      { url: "https://shop.test/pages/faq", content: faq, canonical: "https://shop.test/faq/" },
      { url: "https://shop.test/faq/", content: faq, canonical: "https://shop.test/faq/" },
    ], CTX);
    expect(out.map((e) => e.metadata.sourceUrl)).toEqual(["https://shop.test/", "https://shop.test/faq/"]);
  });

  it("no canonical: the shortest path is kept", () => {
    const about = "Our story: we design in Copenhagen and make in small runs in Portugal and Italy.";
    const out = projectPages([
      { url: "https://shop.test/pages/about-us", content: about },
      { url: "https://shop.test/about", content: about },
    ], CTX);
    expect(out.map((e) => e.metadata.sourceUrl)).toEqual(["https://shop.test/about"]);
  });

  it("a page is titled by its own title, else its address", () => {
    const out = projectPages([
      { url: "https://shop.test/faq/", content: "Frequently asked questions about orders and delivery.", title: "FAQ" },
      { url: "https://shop.test/contact/", content: "Write to us at hello@shop.test or call 03-555-1234." },
    ], CTX);
    expect(out.map((e) => e.title)).toEqual(["FAQ", "https://shop.test/contact/"]);
  });
});

describe("★ the header and footer every page repeats are removed", () => {
  it("from each page but the home page", () => {
    const out = projectPages([
      { url: "https://shop.test/", content: page("Welcome to the shop, considered clothing designed in Copenhagen."), home: true },
      { url: "https://shop.test/faq/", content: page("Frequently asked questions about orders, sizing and delivery times.") },
      { url: "https://shop.test/shipping/", content: page("Shipping takes 2-4 business days within Israel; returns within 30 days.") },
      { url: "https://shop.test/about/", content: page("Our story: designed in Copenhagen, made in small runs in Portugal.") },
    ], CTX);
    const by = Object.fromEntries(out.map((e) => [e.metadata.sourceUrl, e.content]));
    expect(by["https://shop.test/faq/"]).toBe("Frequently asked questions about orders, sizing and delivery times.");
    expect(by["https://shop.test/shipping/"]).toBe("Shipping takes 2-4 business days within Israel; returns within 30 days.");
    // The home page keeps them: what they say (free shipping over 299) stays known once.
    expect(by["https://shop.test/"]).toContain("Free shipping on orders over 299");
  });

  it(`★ a short site (fewer than ${BOILERPLATE_MIN_PAGES} distinct pages) is not touched`, () => {
    const out = projectPages([
      { url: "https://shop.test/", content: page("Welcome to the shop, considered clothing designed in Copenhagen."), home: true },
      { url: "https://shop.test/faq/", content: page("Frequently asked questions about orders and sizing.") },
    ], CTX);
    expect(out[1]!.content).toContain(HEAD);
  });

  it("★ never strips a page to nothing", () => {
    const out = projectPages([
      { url: "https://shop.test/", content: page("Home welcome text, considered clothing from Copenhagen."), home: true },
      { url: "https://shop.test/a/", content: page("Sale") },
      { url: "https://shop.test/b/", content: page("Delivery and returns: 30 days, free within Israel over 299.") },
      { url: "https://shop.test/c/", content: page("About the studio in Tel Aviv, open Sunday to Thursday 10-18.") },
    ], CTX);
    const a = out.find((e) => e.metadata.sourceUrl === "https://shop.test/a/")!;
    expect(a.content).toBe(page("Sale"));
  });
});

const DISCOVERY: any = {
  websiteDomain: "shop.test",
  business: { name: "HALVO", summary: "Considered clothing designed in Copenhagen.", pricingModel: "retail prices shown per product (direct-to-consumer online prices)" },
  knowledge: { policies: { shipping: "Free shipping over 299 within Israel", returns: "30-day free returns" } },
  communication: { channels: [{ type: "contact_form", purpose: "General inquiries" }, { type: "email", identifier: "hello@shop.test" }, { type: "whatsapp", identifier: "+972 50 555 1234" }] },
};

describe("★ topics", () => {
  it("contact channels in words, and only the ones a customer can use", () => {
    const out = projectDiscoveryTopics(DISCOVERY, {}, CTX);
    const contact = out.find((e) => e.metadata.topic === "contact_hours")!;
    expect(contact.content).toContain("אימייל - hello@shop.test");
    expect(contact.content).toContain("WhatsApp - +972 50 555 1234");
    expect(contact.content).not.toContain("contact_form");
    expect(contact.content).not.toContain("General inquiries");
  });

  it("★ a policy topic with no fact in it is skipped and reported; a short real one is kept", () => {
    const skipped: SkippedTopic[] = [];
    const out = projectDiscoveryTopics({ ...DISCOVERY, communication: { channels: [{ type: "contact_form" }] } }, {}, CTX, skipped);
    const topics = out.map((e) => e.metadata.topic);
    expect(topics).not.toContain("contact_hours");
    expect(topics).toContain("shipping_returns");
    expect(skipped).toEqual(expect.arrayContaining([{ topic: "contact_hours", reason: "empty" }, { topic: "pricing_policies", reason: "thin" }]));
    expect(topics).not.toContain("pricing_policies");
    expect(hasConcreteFact("## Pricing model\nretail prices shown per product")).toBe(false);
    expect(hasConcreteFact("## Returns\nReturns within 14 days.")).toBe(true);
  });

  it("Hebrew workspace: Hebrew titles", () => {
    const out = projectDiscoveryTopics(DISCOVERY, {}, CTX);
    expect(out.find((e) => e.metadata.topic === "business_overview")?.title).toBe("סקירת העסק");
  });
});
