/**
 * The widget's brand candidates from the merchant's home page (2026-11-11):
 * each source in its order, absolute URLs, formats the upload can never take
 * skipped, colours rejected or darkened for white text, and every extra fetch
 * through the SSRF guard (a stylesheet or a manifest on 169.254.169.254 or a
 * 10.x address is refused before any request leaves).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  extractBrandCandidates,
  guardedTextFetch,
  normalizeColor,
  withWhiteContrast,
  contrastWithWhite,
  isNearWhiteOrBlack,
  buttonColor,
  widgetLanguage,
  prefillWidgetFromScan,
  prefillContext,
  MIN_CONTRAST,
} from "../services/widget-brand-extract";

const ORIGIN = "https://shop.example";
const none = async () => null;

afterEach(() => vi.restoreAllMocks());

describe("logo", () => {
  it("apple-touch-icon, then sized icons (64px and up), then the manifest, the header logo, og:image; absolute URLs", async () => {
    const html = `<html lang="he"><head>
      <link rel="icon" href="/fav-32.png" sizes="32x32">
      <link rel="icon" href="/fav-192.png" sizes="192x192">
      <link rel="apple-touch-icon" href="/apple.png">
      <link rel="icon" href="/fav.svg">
      <link rel="shortcut icon" href="/favicon.ico">
      <link rel="manifest" href="/site.webmanifest">
      <meta property="og:image" content="https://cdn.shop.example/og.jpg">
      </head><body><header><a href="/"><img class="custom-logo" src="/wp-content/uploads/logo.png" alt="Shop"></a><img src="/cart.png"></header></body></html>`;
    const fetchText = async (url: string) => (url.endsWith("site.webmanifest") ? JSON.stringify({ icons: [{ src: "icons/512.png", sizes: "512x512" }] }) : null);
    const c = await extractBrandCandidates(ORIGIN, html, fetchText);
    expect(c.logos.map((l) => [l.source, l.url])).toEqual([
      ["apple-touch-icon", "https://shop.example/apple.png"],
      ["icon", "https://shop.example/fav-192.png"],
      ["manifest", "https://shop.example/icons/512.png"],
      ["header-img", "https://shop.example/wp-content/uploads/logo.png"],
    ]);
    // SVG and ICO are never candidates: the upload refuses them.
    expect(c.logos.some((l) => /\.(svg|ico)$/.test(l.url))).toBe(false);
    expect(c.language).toBe("he");
  });

  it("og:image is the last resort for the logo and the first for the hero", async () => {
    const html = `<head><meta property="og:image" content="/og.jpg"></head><body><div class="hero-banner"><img src="/banner.jpg" width="1600"><img src="/tiny.jpg" width="40"></div></body>`;
    const c = await extractBrandCandidates(ORIGIN, html, none);
    expect(c.logos.map((l) => l.url)).toEqual(["https://shop.example/og.jpg"]);
    expect(c.heroes.map((h) => h.url)).toEqual(["https://shop.example/og.jpg", "https://shop.example/banner.jpg"]);
  });
});

describe("what is never a candidate", () => {
  it("an inline SVG icon (the demo store's) and a stray-quoted href are dropped", async () => {
    const html = `<head><link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect/></svg>"></head>`;
    const c = await extractBrandCandidates(ORIGIN, html, none);
    expect(c.logos).toEqual([]);
  });

  it("an http image on an https site is asked for over https", async () => {
    const c = await extractBrandCandidates(ORIGIN, `<head><meta property="og:image" content="http://shop.example/cdn/og.jpg"></head>`, none);
    expect(c.heroes[0]!.url).toBe("https://shop.example/cdn/og.jpg");
  });

  it("a password page gives nothing: its button colour is the platform's (Shopify #008060)", async () => {
    const html = `<html lang="en"><head><meta name="theme-color" content="#008060"><meta property="og:image" content="/og.png"></head>
      <body><form method="post" action="/password"><input type="password" name="password"></form><style>button{background:#008060}</style></body></html>`;
    const c = await extractBrandCandidates(ORIGIN, html, none);
    expect(c).toMatchObject({ logos: [], colors: [], heroes: [], language: "en", rejected: [{ reason: "gated_page" }] });
  });
});

describe("why a candidate was left out (the console preview shows it)", () => {
  it("svg, too small, near white, duplicate: each with its fixed reason", async () => {
    const html = `<head><link rel="icon" href="/a.svg"><link rel="icon" href="/b.png" sizes="16x16"><meta name="theme-color" content="#fefefe">
      <style>:root{--primary:#1d4ed8;--accent:#1d4ed8}</style></head>`;
    const c = await extractBrandCandidates(ORIGIN, html, none);
    expect(c.rejected.map((r) => [r.kind, r.reason])).toEqual([
      ["logo", "too_small"], ["logo", "svg_unsafe"], ["color", "near_white_or_black"], ["color", "duplicate"],
    ]);
  });
});

describe("colour", () => {
  it("theme-color first, then the manifest, CSS variables, the button colour; near-white and near-black rejected", async () => {
    const html = `<head><meta name="theme-color" content="#ffffff"><link rel="manifest" href="/m.json"><link rel="stylesheet" href="/wp-content/themes/x/style.css">
      <style>:root{--color-primary:#0f766e}</style></head><body></body>`;
    const fetchText = async (url: string) =>
      url.endsWith("m.json") ? JSON.stringify({ theme_color: "#7e22ce" })
        : url.endsWith("style.css") ? ".btn{background:#b91c1c}.btn:hover{background:#000}button{background-color:#b91c1c}.footer{background:#c2410c}" : null;
    const c = await extractBrandCandidates(ORIGIN, html, fetchText);
    expect(c.colors.map((x) => [x.source, x.hex])).toEqual([
      ["manifest", "#7e22ce"],
      ["css-variable", "#0f766e"],
      ["button", "#b91c1c"],
    ]);
  });

  it("a colour white text cannot sit on is darkened, same hue, until it reads", () => {
    for (const c of ["#ffcc00", "#38bdf8", "#f472b6"]) {
      const d = withWhiteContrast(c);
      expect(contrastWithWhite(c)).toBeLessThan(MIN_CONTRAST);
      expect(contrastWithWhite(d)).toBeGreaterThanOrEqual(MIN_CONTRAST);
      expect(d).not.toBe("#000000");
    }
    expect(withWhiteContrast("#1d4ed8")).toBe("#1d4ed8");
  });

  it("parses the colour forms a stylesheet uses; see-through is not a colour", () => {
    expect(normalizeColor("#ABC")).toBe("#aabbcc");
    expect(normalizeColor("#1d4ed8ff")).toBe("#1d4ed8");
    expect(normalizeColor("rgb(29, 78, 216)")).toBe("#1d4ed8");
    expect(normalizeColor("rgba(29,78,216,0.2)")).toBeNull();
    expect(normalizeColor("var(--x)")).toBeNull();
    expect(isNearWhiteOrBlack("#fafafa")).toBe(true);
    expect(isNearWhiteOrBlack("#0a0a0a")).toBe(true);
    expect(buttonColor(".site-header{background:#123}")).toBeNull();
  });
});

describe("the SSRF guard on every extra fetch", () => {
  it("a manifest or stylesheet on a metadata or private address is refused before any request", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    for (const url of ["http://169.254.169.254/latest/meta-data/", "http://10.0.0.5/style.css", "http://127.0.0.1/m.json", "http://[::1]/a.css"]) {
      expect(await guardedTextFetch(url, 1000)).toBeNull();
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("the extraction itself uses the guard by default", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const html = `<head><link rel="manifest" href="http://169.254.169.254/m.json"><link rel="stylesheet" href="http://10.1.2.3/theme.css"></head>`;
    const c = await extractBrandCandidates(ORIGIN, html);
    expect(spy).not.toHaveBeenCalled();
    expect(c.colors).toEqual([]);
  });

  it("a body past the cap is refused, not cut", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("x".repeat(5000), { status: 200, headers: { "content-length": "5000" } }));
    expect(await guardedTextFetch("https://93.184.216.34/big.css", 1000)).toBeNull();
  });
});

describe("language", () => {
  it("from the html lang, else from the letters", () => {
    expect(widgetLanguage(`<html lang="he-IL">`)).toBe("he");
    expect(widgetLanguage(`<html lang="en-US">`)).toBe("en");
    expect(widgetLanguage(`<html><body>${"שלום עולם ".repeat(40)}</body></html>`)).toBe("he");
    expect(widgetLanguage(`<html><body>hello</body></html>`)).toBeNull();
  });
});

describe("the hand-over", () => {
  it("sends the candidates and what the scan learned; a failure never throws", async () => {
    const sent: any[] = [];
    await prefillWidgetFromScan(
      { authorization: "Bearer a", origin: ORIGIN, candidates: { logos: [], colors: [{ hex: "#1d4ed8", original: "#1d4ed8", source: "theme-color" }], heroes: [], language: "he", rejected: [] }, report: { business: { name: "Shop", summary: "Scarves" }, brand: { voice: "warm" } } },
      async (auth, body) => { sent.push([auth, body]); return { status: "done" }; },
    );
    expect(sent[0][0]).toBe("Bearer a");
    expect(sent[0][1]).toMatchObject({ domain: ORIGIN, language: "he", colors: [{ hex: "#1d4ed8" }], context: { businessName: "Shop", summary: "Scarves", voice: "warm" } });
    await expect(prefillWidgetFromScan({ authorization: "x", origin: ORIGIN, candidates: null, report: null }, async () => { throw new Error("down"); })).resolves.toBeNull();
    expect(prefillContext(null)).toMatchObject({ businessName: null });
  });
});

describe("the preview's inputs", () => {
  it("a typed site becomes the https origin; junk is refused", async () => {
    const { previewOrigin, pageContext } = await import("../services/widget-brand-extract");
    expect(previewOrigin("shop.co.il/about?x=1")).toBe("https://shop.co.il");
    expect(previewOrigin("http://shop.co.il")).toBe("http://shop.co.il");
    expect(previewOrigin("localhost")).toBeNull();
    expect(previewOrigin("javascript:alert(1)")).toBeNull();
    expect(previewOrigin(42)).toBeNull();
    expect(pageContext({ html: `<meta name="description" content="Scarves">`, text: "Hand made", siteName: "Shop" })).toMatchObject({ businessName: "Shop", summary: "Scarves | Hand made" });
  });
});
