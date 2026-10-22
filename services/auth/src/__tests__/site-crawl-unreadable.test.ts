/**
 * A page that did not answer in time is not a page that is gone (2026-10-14).
 *
 * Measured on the demo store: most pages answered in 0.2-0.8s and one or two
 * per crawl in 5-6s, past the 6s timeout, while all 16 were fetched at once.
 * The page set changed from run to run, so every rescan ran in full and a
 * timed-out page's knowledge was removed. These pin the crawl's half of the
 * fix: four at a time, one retry, and "unreadable" reported apart from "gone".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const net = vi.hoisted(() => ({ answer: (_url: string): any => ({ ok: true, status: 200, text: "<html><body>x</body></html>", contentType: "text/html" }) }));
vi.mock("@chatcenter/shared", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  safeFetch: vi.fn(async (url: string) => net.answer(url)),
}));

import { crawlSite, fetchPageForCrawl, CRAWL_CONCURRENCY, type PageFetcher } from "../services/site-crawl.service";

const ORIGIN = "https://shop.example.com";
const HOME = `<html><body><a href="/about">About</a><a href="/shipping">Shipping</a><a href="/contact">Contact</a></body></html>`;

beforeEach(() => {
  net.answer = () => ({ ok: true, status: 200, text: "<html><body>x</body></html>", contentType: "text/html" });
});

describe("fetchPageForCrawl tells gone from unreadable", () => {
  it.each([
    [0, true], [408, true], [429, true], [500, true], [503, true],
    [404, false], [410, false], [403, false],
  ])("status %i: unreadable=%s", async (status, unreadable) => {
    net.answer = () => ({ ok: false, status, text: "", error: status === 0 ? "This operation was aborted" : undefined });
    const r = await fetchPageForCrawl(`${ORIGIN}/p`);
    expect(r).toEqual(unreadable ? { unreadable: true } : null);
  });

  it("a non-HTML answer is gone, not unreadable", async () => {
    net.answer = () => ({ ok: true, status: 200, text: "{}", contentType: "application/json" });
    expect(await fetchPageForCrawl(`${ORIGIN}/p`)).toBeNull();
  });
});

describe("crawlSite: four at a time, one retry, unreadable reported", () => {
  it(`★ never more than ${CRAWL_CONCURRENCY} page fetches in flight`, async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchPage: PageFetcher = async (url) => {
      if (url === ORIGIN) return { html: HOME, text: "home" };
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { html: "<p>page</p>", text: `page ${url}` };
    };
    const crawl = await crawlSite(ORIGIN, { fetchPage });
    expect(crawl!.requested.length).toBeGreaterThan(CRAWL_CONCURRENCY + 1);
    expect(CRAWL_CONCURRENCY).toBe(4);
    expect(peak).toBe(CRAWL_CONCURRENCY);
  });

  it("★ a page that times out once is retried, with longer, and read", async () => {
    const calls: Array<[string, number | undefined]> = [];
    const fetchPage: PageFetcher = async (url, t) => {
      calls.push([url, t]);
      if (url === ORIGIN) return { html: HOME, text: "home" };
      if (url === `${ORIGIN}/shipping` && calls.filter((c) => c[0] === url).length === 1) return { unreadable: true };
      return { html: "<p>page</p>", text: `page ${url}` };
    };
    const crawl = await crawlSite(ORIGIN, { fetchPage });
    expect(crawl!.pages.map((p) => p.url)).toContain(`${ORIGIN}/shipping`);
    expect(crawl!.unreadable).toEqual([]);
    expect(calls.filter((c) => c[0] === `${ORIGIN}/shipping`).map((c) => c[1])).toEqual([6000, 10000]);
  });

  it("★ still unreadable after the retry: listed in unreadable, not in pages", async () => {
    const fetchPage: PageFetcher = async (url) => {
      if (url === ORIGIN) return { html: HOME, text: "home" };
      if (url === `${ORIGIN}/shipping`) return { unreadable: true };
      if (url === `${ORIGIN}/about`) return null;
      return { html: "<p>page</p>", text: `page ${url}` };
    };
    const crawl = await crawlSite(ORIGIN, { fetchPage });
    expect(crawl!.unreadable).toEqual([`${ORIGIN}/shipping`]);
    const urls = crawl!.pages.map((p) => p.url);
    expect(urls).not.toContain(`${ORIGIN}/shipping`);
    // Gone is not unreadable.
    expect(urls).not.toContain(`${ORIGIN}/about`);
    expect(crawl!.unreadable).not.toContain(`${ORIGIN}/about`);
  });

  it("the home page gets one retry too; unreadable twice is a failed crawl", async () => {
    let homeCalls = 0;
    const once: PageFetcher = async (url) => {
      if (url === ORIGIN) return ++homeCalls === 1 ? { unreadable: true } : { html: HOME, text: "home" };
      return null;
    };
    expect(await crawlSite(ORIGIN, { fetchPage: once })).not.toBeNull();
    expect(await crawlSite(ORIGIN, { fetchPage: async () => ({ unreadable: true }) })).toBeNull();
  });
});

// ─── Cloudflare email protection, and product tiles (2026-10-14) ───────────
import { decodeCfEmail, decodeCfEmails, withoutProductTiles, stableTextOf, htmlToText } from "../services/site-crawl.service";

/** Cloudflare's encoding: a key byte, then each byte XORed with it. */
const cf = (email: string, key = 0x5a) =>
  [key, ...Buffer.from(email, "utf8")].map((b, i) => (i === 0 ? b : b ^ key).toString(16).padStart(2, "0")).join("");

describe("★ Cloudflare-protected emails are read as the address", () => {
  it("decodes the span and turns the link back into a mailto", () => {
    const hex = cf("hello@halvo.co.il");
    const html = `<p>Email <a href="/cdn-cgi/l/email-protection#${hex}"><span class="__cf_email__" data-cfemail="${hex}">[email&#160;protected]</span></a></p>`;
    const out = decodeCfEmails(html);
    expect(htmlToText(out)).toBe("Email hello@halvo.co.il");
    expect(out).toContain(`href="mailto:hello@halvo.co.il"`);
  });

  it("another key decodes the same; garbage stays as it was", () => {
    expect(decodeCfEmail(cf("a.b@x.com", 0x11))).toBe("a.b@x.com");
    expect(decodeCfEmail("zz")).toBeNull();
    expect(decodeCfEmail(cf("not an email"))).toBeNull();
    const bad = `<span data-cfemail="${cf("not an email")}">[email protected]</span>`;
    expect(decodeCfEmails(bad)).toBe(bad);
  });

  it("the crawl's fetch decodes it, so the model and the signals see the address", async () => {
    const hex = cf("care@shop.co.il");
    net.answer = () => ({ ok: true, status: 200, contentType: "text/html", text: `<html><body>Write to <span class="__cf_email__" data-cfemail="${hex}">[email protected]</span></body></html>` });
    const r: any = await fetchPageForCrawl(`${ORIGIN}/contact`);
    expect(r.text).toBe("Write to care@shop.co.il");
  });
});

describe("★ the rescan's checksum text leaves product tiles out", () => {
  const WOO = `<ul class="products"><li class="product type-product post-313 instock"><a href="/product/chino/"><h3 class="card__title">Chino Pants</h3></a><ul class="card__swatches"><li>Navy</li><li>Sand</li></ul><span class="price">₪ 319</span></li></ul>`;
  const SHOP = `<div class="card-wrapper product-card-wrapper"><a href="/products/linen-shirt">Relaxed Linen Shirt</a><span>₪ 329</span></div>`;
  const page = (tiles: string) => `<html><body><h2>Best Sellers</h2>${tiles}<p>Free shipping over ₪299</p><ul><li class="menu-item">Contact</li></ul></body></html>`;

  it("a WooCommerce tile goes whole, nested swatches included; the rest stays", () => {
    expect(stableTextOf(page(WOO))).toBe("Best Sellers Free shipping over ₪299 Contact");
  });

  it("a Shopify card around a /products/ link goes; a card-wrapper with no product link stays", () => {
    expect(stableTextOf(page(SHOP))).toBe("Best Sellers Free shipping over ₪299 Contact");
    const notProduct = `<div class="card-wrapper"><a href="/pages/hours">Open Sun-Thu 9-17</a></div>`;
    expect(stableTextOf(page(notProduct))).toContain("Open Sun-Thu 9-17");
  });

  it("★ two pages that differ only in which products are listed read the same", () => {
    const other = WOO.replace("Chino Pants", "Relaxed Linen Shirt").replace("319", "329");
    expect(stableTextOf(page(other))).toBe(stableTextOf(page(WOO)));
    // Only the checksum text: the page as read still has them.
    expect(htmlToText(page(WOO))).toContain("Chino Pants");
    expect(withoutProductTiles(page(WOO))).not.toContain("Chino");
  });

  it("crawlSite carries the stable text per page; the pages sent to the model keep their tiles", async () => {
    const fetchPage: PageFetcher = async (url) => {
      const html = page(WOO);
      return url === ORIGIN ? { html: HOME + html, text: htmlToText(HOME + html) } : null;
    };
    const crawl = await crawlSite(ORIGIN, { fetchPage });
    expect(crawl!.pages[0]!.text).toContain("Chino Pants");
    expect(crawl!.stableTexts[ORIGIN]).not.toContain("Chino Pants");
    expect(crawl!.stableTexts[ORIGIN]).toContain("Free shipping");
  });
});
