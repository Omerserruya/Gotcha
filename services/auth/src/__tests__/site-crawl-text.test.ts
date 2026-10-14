/**
 * Page text, titles and canonicals as the crawler reads them (2026-10-14). Every
 * dev page doc began `Ø "> HALVØ &#8211;`: the tag strip ran over <head>, the
 * favicon's data-URI attribute (an <svg> holding "Ø") ended a tag early, and
 * numeric entities were never decoded.
 */
import { describe, it, expect } from "vitest";
import { htmlToText, pageTitle, canonicalOf, decodeEntities } from "../services/site-crawl.service";

const HTML = `<!doctype html><html><head>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'><text x='32'>Ø</text></svg>">
<title>FAQ &#8211; HALVØ</title>
<link rel="canonical" href="https://shop.test/faq/" />
</head><body class="page"><a class="skip" href="#main">Skip to content</a>
<img alt="a > b" src="x.png"><svg viewBox="0 0 1 1"><path d="M0 0"/></svg>
<h1>Frequently asked <em>questions</em></h1><p>Shipping &amp; returns: 30&#8211;day returns &#038; free shipping over &#8362;299.</p>
<script>var x = "<p>not text</p>";</script></body></html>`;

describe("htmlToText", () => {
  it("★ reads the body only: no favicon debris, no attribute leftovers, entities decoded", () => {
    const t = htmlToText(HTML);
    expect(t).not.toMatch(/Ø ">|&#|data:image|not text|M0 0/);
    expect(t).toBe("Skip to content Frequently asked questions Shipping & returns: 30-day returns & free shipping over ₪299.");
  });
  it("a page with no <body> still drops its <head>", () => {
    expect(htmlToText("<head><title>T</title></head><p>Hello there</p>")).toBe("Hello there");
  });
  it("dash entities read as a hyphen; unknown entities stay as written", () => {
    expect(decodeEntities("a&#8211;b &mdash; c &#x2014; d &foo;")).toBe("a-b - c - d &foo;");
  });
});

describe("pageTitle and canonicalOf", () => {
  it("★ the h1 first, else the <title> without the site name", () => {
    expect(pageTitle(HTML)).toBe("Frequently asked questions");
    expect(pageTitle("<title>Shipping &#038; Returns &#8211; HALVØ</title>")).toBe("Shipping & Returns");
    expect(pageTitle("<p>none</p>")).toBeNull();
  });
  it("the canonical, absolute", () => {
    expect(canonicalOf(HTML, "https://shop.test/pages/faq")).toBe("https://shop.test/faq/");
    expect(canonicalOf('<link href="/about/" rel="canonical">', "https://shop.test/pages/about")).toBe("https://shop.test/about/");
    expect(canonicalOf("<p></p>", "https://shop.test/")).toBeNull();
  });
});
