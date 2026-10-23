/**
 * Learn-the-site, stage 1 (2026-10-23): which pages are read, and what the
 * platform's own data says. Pure functions over fake fetchers - no network.
 */
import { describe, it, expect } from "vitest";
import { parseRobots, allowedByRobots, locsOf, kindOf, planPages, discoverSitemapUrls } from "../services/onboarding-discover/sitemap";
import { harvestShopify, harvestWoo, detectPlatform, type Fetcher } from "../services/onboarding-discover/harvest";

const O = "https://shop.example";

/** A fetcher over a fixed map of URL → body (404 for anything else). */
function site(map: Record<string, string | { status: number; text?: string }>): Fetcher & { asked: string[] } {
  const asked: string[] = [];
  const f = (async (url: string) => {
    asked.push(url);
    const v = map[url];
    if (v === undefined) return { ok: false, status: 404, text: "" };
    if (typeof v === "string") return { ok: true, status: 200, text: v };
    return { ok: v.status < 300, status: v.status, text: v.text ?? "" };
  }) as Fetcher & { asked: string[] };
  f.asked = asked;
  return f;
}

describe("robots.txt", () => {
  const rules = parseRobots(`
User-agent: Googlebot
Disallow: /only-google

User-agent: *
Disallow: /cart
Disallow: /*?sort=
Disallow: /checkout$
# a comment
Sitemap: https://shop.example/sitemap.xml
Sitemap: https://shop.example/extra.xml
`);
  it("reads the * group and every sitemap line", () => {
    expect(rules.disallow).toEqual(["/cart", "/*?sort=", "/checkout$"]);
    expect(rules.sitemaps).toEqual(["https://shop.example/sitemap.xml", "https://shop.example/extra.xml"]);
  });
  it("honours prefixes, wildcards and the end anchor; another bot's rules do not apply", () => {
    expect(allowedByRobots(`${O}/cart/x`, rules)).toBe(false);
    expect(allowedByRobots(`${O}/collections/a?sort=price`, rules)).toBe(false);
    expect(allowedByRobots(`${O}/checkout`, rules)).toBe(false);
    expect(allowedByRobots(`${O}/checkout/thanks`, rules)).toBe(true);
    expect(allowedByRobots(`${O}/only-google`, rules)).toBe(true);
    expect(allowedByRobots(`${O}/pages/faq`, rules)).toBe(true);
  });
});

describe("sitemaps", () => {
  it("tells an index from a url set, and decodes CDATA and &amp;", () => {
    expect(locsOf(`<sitemapindex><sitemap><loc>${O}/s1.xml</loc></sitemap></sitemapindex>`)).toEqual({ urls: [], sitemaps: [`${O}/s1.xml`] });
    expect(locsOf(`<urlset><url><loc><![CDATA[${O}/a?x=1&amp;y=2]]></loc></url></urlset>`).urls).toEqual([`${O}/a?x=1&y=2`]);
  });

  it("follows robots → index → children, pages before products", async () => {
    const f = site({
      [`${O}/robots.txt`]: `User-agent: *\nSitemap: ${O}/sitemap.xml`,
      [`${O}/sitemap.xml`]: `<sitemapindex><sitemap><loc>${O}/sitemap_products_1.xml</loc></sitemap><sitemap><loc>${O}/sitemap_pages_1.xml</loc></sitemap></sitemapindex>`,
      [`${O}/sitemap_pages_1.xml`]: `<urlset><url><loc>${O}/pages/faq</loc></url></urlset>`,
      [`${O}/sitemap_products_1.xml`]: `<urlset><url><loc>${O}/products/a</loc></url></urlset>`,
    });
    const out = await discoverSitemapUrls(O, f);
    expect(out.urls).toEqual([`${O}/pages/faq`, `${O}/products/a`]);
    expect(f.asked.indexOf(`${O}/sitemap_pages_1.xml`)).toBeLessThan(f.asked.indexOf(`${O}/sitemap_products_1.xml`));
  });

  it("WordPress: /wp-sitemap.xml when robots names none, and only one of the fallbacks is read", async () => {
    const f = site({
      [`${O}/wp-sitemap.xml`]: `<sitemapindex><sitemap><loc>${O}/wp-sitemap-posts-page-1.xml</loc></sitemap></sitemapindex>`,
      [`${O}/wp-sitemap-posts-page-1.xml`]: `<urlset><url><loc>${O}/returns</loc></url></urlset>`,
      [`${O}/sitemap_index.xml`]: `<urlset><url><loc>${O}/dup</loc></url></urlset>`,
    });
    const out = await discoverSitemapUrls(O, f);
    expect(out.urls).toEqual([`${O}/returns`]);
    expect(f.asked).not.toContain(`${O}/sitemap_index.xml`);
  });

  it("falls back to /sitemap.xml when robots names none", async () => {
    const f = site({ [`${O}/sitemap.xml`]: `<urlset><url><loc>${O}/about</loc></url></urlset>` });
    expect((await discoverSitemapUrls(O, f)).urls).toEqual([`${O}/about`]);
  });
});

describe("page kinds, including Hebrew slugs", () => {
  it.each([
    [`${O}/policies/refund-policy`, "returns"],
    [`${O}/pages/%D7%9E%D7%93%D7%99%D7%A0%D7%99%D7%95%D7%AA-%D7%94%D7%97%D7%96%D7%A8%D7%95%D7%AA`, "returns"],
    [`${O}/pages/משלוחים`, "shipping"],
    [`${O}/pages/שאלות-נפוצות`, "faq"],
    [`${O}/pages/about-us`, "about"],
    [`${O}/pages/צור-קשר`, "contact"],
    [`${O}/products/blue-shirt`, "product"],
    [`${O}/blogs/news/x`, "blog"],
    [`${O}/policies/privacy-policy`, "policy"],
  ])("%s → %s", (url, kind) => expect(kindOf(url)).toBe(kind));
});

describe("the reading plan", () => {
  const robots = { sitemaps: [], disallow: ["/secret"] };
  const sitemapUrls = [
    `${O}/blogs/news/1`, `${O}/products/a`, `${O}/products/b`, `${O}/pages/about`,
    `${O}/pages/faq`, `${O}/secret/page`, `https://other.example/pages/faq`,
    `${O}/pages/contact?utm_source=x`, `${O}/pages/contact`,
  ];

  it("home first, platform policies next, then by value; never another host, a robots-blocked page or a duplicate", () => {
    const plan = planPages({ origin: O, sitemapUrls, platformPolicyUrls: [`${O}/policies/refund-policy`], haveProductFeed: true, robots });
    expect(plan.map((p) => p.url)).toEqual([O, `${O}/policies/refund-policy`, `${O}/pages/faq`, `${O}/pages/about`, `${O}/pages/contact`]);
  });

  it("reads a few product pages only when the platform feed said nothing", () => {
    const withFeed = planPages({ origin: O, sitemapUrls, platformPolicyUrls: [], haveProductFeed: true, robots });
    const noFeed = planPages({ origin: O, sitemapUrls, platformPolicyUrls: [], haveProductFeed: false, robots });
    expect(withFeed.some((p) => p.kind === "product")).toBe(false);
    expect(noFeed.filter((p) => p.kind === "product")).toHaveLength(2);
  });

  it("is capped, however big the site", () => {
    const many = Array.from({ length: 400 }, (_, i) => `${O}/pages/p${i}`);
    expect(planPages({ origin: O, sitemapUrls: many, platformPolicyUrls: [], haveProductFeed: true, robots, cap: 50 })).toHaveLength(50);
  });
});

describe("Shopify feed", () => {
  const prod = (i: number, type: string, price: string, available = true) => ({
    title: `Item ${i}`, handle: `item-${i}`, product_type: type, variants: [{ price, available }],
  });

  it("summarises the catalogue exactly from /products.json", async () => {
    const f = site({
      [`${O}/products.json?limit=250&page=1`]: JSON.stringify({ products: [prod(1, "Shirts", "99.90"), prod(2, "Shirts", "149"), prod(3, "Hats", "49", false)] }),
    });
    const h = await harvestShopify(O, f);
    expect(h.products).toMatchObject({
      count: 3, more: false, categories: ["Shirts", "Hats"], inStock: 2,
      priceRange: { min: 49, max: 149, currency: null }, source: "shopify_feed",
    });
    expect(h.products!.highlights[0]).toEqual({ title: "Item 1", url: `${O}/products/item-1`, price: 99.9 });
    expect(h.policyUrls).toContain(`${O}/policies/refund-policy`);
  });

  it("pages through a big store and says when it stopped short", async () => {
    const full = JSON.stringify({ products: Array.from({ length: 250 }, (_, i) => prod(i, "T", "10")) });
    const map: Record<string, string> = {};
    for (let p = 1; p <= 4; p++) map[`${O}/products.json?limit=250&page=${p}`] = full;
    const h = await harvestShopify(O, site(map));
    expect(h.products).toMatchObject({ count: 1000, more: true });
  });

  it("a disabled feed is reported, not invented", async () => {
    const h = await harvestShopify(O, site({ [`${O}/products.json?limit=250&page=1`]: { status: 404 } }));
    expect(h.products).toBeNull();
    expect(h.feedUnavailable).toBe("disabled");
  });
});

describe("WooCommerce Store API", () => {
  it("reads minor units, the currency and categories", async () => {
    const f = site({
      [`${O}/wp-json/wc/store/v1/products?per_page=100&page=1`]: JSON.stringify([
        { name: "Mug", permalink: `${O}/p/mug`, prices: { price: "4990", currency_code: "ILS", currency_minor_unit: 2 }, categories: [{ name: "Kitchen" }], is_in_stock: true },
        { name: "Bowl", permalink: `${O}/p/bowl`, prices: { price: "12900", currency_code: "ILS", currency_minor_unit: 2 }, categories: [{ name: "Kitchen" }, { name: "Gifts" }], is_in_stock: false },
      ]),
    });
    const h = await harvestWoo(O, f);
    expect(h.products).toMatchObject({
      count: 2, categories: ["Kitchen", "Gifts"], inStock: 1,
      priceRange: { min: 49.9, max: 129, currency: "ILS" }, source: "woo_store_api",
    });
  });
});

describe("platform detection: the data endpoint is the proof", () => {
  it("a store answers its data endpoint", async () => {
    expect(await detectPlatform(O, null, site({ [`${O}/products.json?limit=1`]: JSON.stringify({ products: [] }) }))).toBe("shopify");
    expect(await detectPlatform(O, null, site({ [`${O}/wp-json/wc/store/v1/products?per_page=1`]: "[]" }))).toBe("woocommerce");
  });
  it("asset markers count only when the endpoints say nothing (a password store)", async () => {
    expect(await detectPlatform(O, "shopify", site({}))).toBe("shopify");
    expect(await detectPlatform(O, null, site({}))).toBeNull();
  });
  it("a site that only MENTIONS a platform in its copy is not that platform (gotcha.co.il, 2026-10-23)", async () => {
    const { platformFromAssets } = await import("../services/onboarding-discover/harvest");
    expect(platformFromAssets("<p>We integrate with WooCommerce and Shopify.</p>")).toBeNull();
    expect(platformFromAssets('<link rel=stylesheet href="/wp-content/plugins/woocommerce/assets/css/woocommerce-layout.css">')).toBe("woocommerce");
    expect(platformFromAssets('<script src="https://cdn.shopify.com/s/files/x.js"></script>')).toBe("shopify");
  });
});

describe("tools come from what the site LOADS, not what it says", async () => {
  const { toolsFromAssets } = await import("../services/onboarding-discover/pipeline");
  it("named in the copy: not a tool", () => {
    expect(toolsFromAssets(["<p>Works with Judge.me, ReturnGO and Klaviyo</p>"])).toEqual([]);
  });
  it("loaded as a script: a tool", () => {
    expect(toolsFromAssets(['<script src="https://static.klaviyo.com/onsite/js/klaviyo.js"></script>', '<script src="https://cdn.judge.me/widget.js"></script>'])).toEqual(expect.arrayContaining(["klaviyo", "judgeme"]));
  });
});

describe("language copies are read once", () => {
  it("/he/about next to /about: only /about; a Hebrew-only page is kept", () => {
    const plan = planPages({
      origin: O,
      sitemapUrls: [`${O}/about`, `${O}/he/about`, `${O}/he/only-hebrew`, `${O}/he`],
      platformPolicyUrls: [], haveProductFeed: true, robots: { sitemaps: [], disallow: [] },
    });
    expect(plan.map((p) => p.url)).toEqual([O, `${O}/about`, `${O}/he/only-hebrew`]);
  });
});

describe("a malformed link never takes the scan down (URIError, found live 2026-10-23)", async () => {
  const { extractInternalLinks, extractSignals } = await import("../services/site-crawl.service");
  it("link extraction and mailto parsing survive a stray %", () => {
    const html = '<a href="/returns%E0%A4%A">Returns</a><a href="mailto:bad%ZZ@x.com">m</a>';
    expect(() => extractInternalLinks(html, O, 10)).not.toThrow();
    expect(() => extractSignals([{ url: O, html }])).not.toThrow();
  });
});
