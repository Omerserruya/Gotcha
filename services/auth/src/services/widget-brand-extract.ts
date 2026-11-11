/**
 * The widget's brand, read from the merchant's own site during the onboarding
 * scan (2026-11-11): logo, colour and hero image candidates, deterministic and
 * without a model. The AI service then picks among them with a vision check and
 * writes the widget (POST /api/ai-assist/widget-prefill).
 *
 * Sources, in order of preference:
 *   logo   apple-touch-icon / icon links, manifest icons, a header <img> that
 *          says "logo" in its src, alt or class, og:image last
 *   colour meta theme-color, manifest theme_color, --primary/--accent style
 *          custom properties, the most common background of buttons and CTAs
 *          in the inline and linked CSS
 *   hero   og:image, else the first large image in a hero/banner block
 *
 * Every extra request (the manifest, up to two stylesheets) goes through the
 * same SSRF guard as the crawl: public addresses only after DNS, every redirect
 * hop re-checked, a byte cap enforced while reading, a timeout. A stylesheet on
 * a CDN is still an arbitrary host, so it gets exactly the same guard.
 *
 * Images are NOT fetched here: the AI service fetches the candidates with the
 * same guard, checks them against the widget upload's own type and size rules,
 * and copies the chosen ones into our media store.
 */
// Deep import: the pure guard, so a test that mocks the barrel still gets it.
import { safeFetchBuffer } from "@chatcenter/shared/src/lib/safe-fetch";
import { decodeEntities } from "./site-crawl.service";

export interface ImageCandidate { url: string; source: string; size: number | null }
export interface ColorCandidate { hex: string; original: string; source: string }
/**
 * Why a candidate was left out. A fixed list, shared with the AI service's own
 * reasons, so the console preview can say each in words.
 */
export type RejectReason = "gated_page" | "svg_unsafe" | "too_small" | "not_a_url" | "near_white_or_black" | "duplicate" | "over_cap";
export interface RejectedCandidate { kind: "logo" | "hero" | "color"; value: string; source: string; reason: RejectReason }
export interface BrandCandidates {
  logos: ImageCandidate[];
  colors: ColorCandidate[];
  heroes: ImageCandidate[];
  language: "he" | "en" | null;
  /** What was seen and left out, and why. */
  rejected: RejectedCandidate[];
}

/** Fetch a small text resource (manifest, stylesheet), or null. */
export type TextFetcher = (url: string, maxBytes: number) => Promise<string | null>;

export const MANIFEST_MAX_BYTES = 64_000;
export const STYLESHEET_MAX_BYTES = 300_000;
export const STYLESHEETS_READ = 2;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_LOGOS = 4;
const MAX_HEROES = 2;
const MAX_COLORS = 4;
const MIN_LOGO_PX = 64;

/** The guarded reader: safeFetchBuffer, so private, loopback and metadata hosts are refused. */
export const guardedTextFetch: TextFetcher = async (url, maxBytes) => {
  const r = await safeFetchBuffer(url, { maxBytes, timeoutMs: FETCH_TIMEOUT_MS, maxRedirects: 3 });
  if (!r.ok || !r.buffer || r.tooLarge) return null;
  return r.buffer.toString("utf8");
};

// ── HTML helpers ─────────────────────────────────────────────────────────────

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  if (!m) return null;
  return decodeEntities((m[2] ?? m[3] ?? m[4] ?? "").trim());
}

function tags(html: string, name: string): string[] {
  return html.match(new RegExp(`<${name}\\b[^>]*>`, "gi")) ?? [];
}

/** An absolute http(s) URL, or null (data:, javascript:, a broken href). */
export function absoluteUrl(raw: string | null, base: string): string | null {
  if (!raw) return null;
  // An inline SVG icon cuts the tag at its own ">", leaving a stray quote.
  const v = raw.trim().replace(/^["']+|["']+$/g, "");
  if (!v || /[<>\s"']/.test(v) || /^(data|javascript|blob):/i.test(v)) return null;
  try {
    const u = new URL(v, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    // An https site's og:image is often written http:// (seen on a Shopify
    // store, 2026-11-11); the upload takes https only, so ask for https.
    if (u.protocol === "http:" && new URL(base).protocol === "https:") u.protocol = "https:";
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Formats the widget upload can never take (it refuses SVG and accepts only
 * PNG, JPEG, GIF and WebP), skipped by extension so nobody fetches them.
 */
function unusableImage(url: string): boolean {
  return /\.(svg|ico)(\?|#|$)/i.test(url);
}

/** The largest square size an icon declares ("180x180", "32x32 64x64"), or null. */
function declaredSize(sizes: string | null | undefined): number | null {
  if (!sizes) return null;
  let best: number | null = null;
  for (const m of sizes.matchAll(/(\d+)\s*x\s*(\d+)/gi)) {
    const n = Math.min(Number(m[1]), Number(m[2]));
    if (best === null || n > best) best = n;
  }
  return best;
}

function metaContent(html: string, key: string): string | null {
  for (const t of tags(html, "meta")) {
    const k = (attr(t, "property") ?? attr(t, "name") ?? "").toLowerCase();
    if (k === key) return attr(t, "content");
  }
  return null;
}

function relOf(tag: string): string[] {
  return (attr(tag, "rel") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
}

// ── colour helpers ───────────────────────────────────────────────────────────

/** "#abc", "#aabbcc", "#aabbccdd", "rgb(1,2,3)", "rgba(...)" as "#rrggbb", else null. */
export function normalizeColor(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,4})$/.exec(v);
  if (m) return "#" + m[1]!.slice(0, 3).split("").map((c) => c + c).join("");
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(v);
  if (m) return "#" + m[1];
  m = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    if (m[4] !== undefined) {
      const a = m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
      if (a < 0.9) return null; // see-through: not the colour anyone sees
    }
    const parts = [m[1], m[2], m[3]].map((n) => Number(n));
    if (parts.some((n) => n > 255)) return null;
    return "#" + parts.map((n) => n.toString(16).padStart(2, "0")).join("");
  }
  return null;
}

function rgbOf(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = rgbOf(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG contrast ratio of this colour against white text. */
export function contrastWithWhite(hex: string): number {
  return 1.05 / (luminance(hex) + 0.05);
}

/** Near white or near black: a page background or body text, never a brand colour. */
export function isNearWhiteOrBlack(hex: string): boolean {
  const l = luminance(hex);
  return l > 0.85 || l < 0.012;
}

export const MIN_CONTRAST = 4.5;

function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = rgbOf(hex).map((c) => c / 255) as [number, number, number];
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function fromHsl(h: number, s: number, l: number): string {
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r: number, g: number, b: number;
  if (s === 0) r = g = b = l;
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue(p, q, h + 1 / 3); g = hue(p, q, h); b = hue(p, q, h - 1 / 3);
  }
  return "#" + [r, g, b].map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("");
}

/** The colour, darkened (same hue and saturation) until white text on it reads. */
export function withWhiteContrast(hex: string): string {
  if (contrastWithWhite(hex) >= MIN_CONTRAST) return hex;
  const [h, s, l0] = toHsl(hex);
  for (let l = l0; l >= 0; l -= 0.01) {
    const c = fromHsl(h, s, Math.max(0, l));
    if (contrastWithWhite(c) >= MIN_CONTRAST) return c;
  }
  return "#000000";
}

const CUSTOM_PROP = /--(?:wp--preset--color--)?(?:color-)?(?:primary|accent|brand|main|theme)(?:-color)?(?:-base|-500)?\s*:\s*([^;}]+)/gi;
const BUTTON_SELECTOR = /(?:^|[\s,>+~])(?:button|\.btn\b|\.button\b|[.#][\w-]*cta[\w-]*|\.add[_-]to[_-]cart|\.single_add_to_cart_button|\.shopify-payment-button|input\[type=["']?submit)/i;

/** Custom properties named like a brand colour, in the order they appear. */
export function customPropertyColors(css: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(CUSTOM_PROP)) {
    const c = normalizeColor(m[1]!.replace(/!important/i, ""));
    if (c) out.push(c);
  }
  return out;
}

/** The most common background colour on button and CTA rules, or null. */
export function buttonColor(css: string): string | null {
  const counts = new Map<string, number>();
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of noComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1]!;
    if (!BUTTON_SELECTOR.test(selector) || /:(?:hover|focus|active|disabled)/i.test(selector)) continue;
    const bg = /background(?:-color)?\s*:\s*([^;]+)/i.exec(m[2]!);
    const c = bg ? normalizeColor(bg[1]!.replace(/!important/i, "").trim().split(/\s+(?![^(]*\))/)[0]) : null;
    if (!c || isNearWhiteOrBlack(c)) continue;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let best: string | null = null;
  let n = 0;
  for (const [c, k] of counts) if (k > n) { best = c; n = k; }
  return best;
}

// ── the extraction ───────────────────────────────────────────────────────────

/** The page's language as the widget names it, or null when it does not say. */
export function widgetLanguage(html: string): "he" | "en" | null {
  const m = /<html\b[^>]*\blang\s*=\s*["']?([a-zA-Z-]+)/i.exec(html);
  const lang = (m?.[1] ?? "").toLowerCase();
  if (lang.startsWith("he") || lang.startsWith("iw")) return "he";
  if (lang.startsWith("en")) return "en";
  // No lang attribute: a page written mostly in Hebrew letters is a Hebrew page.
  const text = html.replace(/<[^>]+>/g, " ");
  const he = (text.match(/[֐-׿]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (he > 200 && he > latin / 3) return "he";
  return null;
}

/** The header block (or, without one, the top of the body) where a logo lives. */
function headerRegion(html: string): string {
  const header = /<header\b[\s\S]*?<\/header>/i.exec(html);
  if (header) return header[0];
  const body = html.search(/<body\b/i);
  return html.slice(Math.max(0, body), Math.max(0, body) + 20_000);
}

function imgSrc(tag: string): string | null {
  return attr(tag, "src") ?? attr(tag, "data-src") ?? attr(tag, "data-lazy-src") ?? (attr(tag, "srcset") ?? "").split(",")[0]?.trim().split(/\s+/)[0] ?? null;
}

/**
 * A home page that asks for a password is a gate (a password-protected
 * Shopify store, a members-only site), not the brand: its colours are the
 * platform's own (Shopify's password page button is #008060, seen on the
 * dev demo store 2026-11-11). Nothing is taken from it.
 */
export function isGatedPage(html: string): boolean {
  return /<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(html)
    || /<form\b[^>]*\baction\s*=\s*["'][^"']*\/password["'?]/i.test(html);
}

export async function extractBrandCandidates(
  origin: string,
  html: string,
  fetchText: TextFetcher = guardedTextFetch,
): Promise<BrandCandidates> {
  const logos: ImageCandidate[] = [];
  const heroes: ImageCandidate[] = [];
  const colors: ColorCandidate[] = [];
  const rejected: RejectedCandidate[] = [];
  if (isGatedPage(html)) {
    rejected.push({ kind: "logo", value: origin, source: "page", reason: "gated_page" });
    return { logos, colors, heroes, language: widgetLanguage(html), rejected };
  }
  const reject = (kind: RejectedCandidate["kind"], value: string | null, source: string, reason: RejectReason) => {
    if (value && rejected.length < 40) rejected.push({ kind, value: value.slice(0, 200), source, reason });
  };
  const addImage = (list: ImageCandidate[], raw: string | null, source: string, size: number | null, cap: number) => {
    const kind = list === logos ? "logo" : "hero";
    if (!raw) return;
    const url = absoluteUrl(raw, origin);
    if (!url) return reject(kind, raw, source, "not_a_url");
    if (list.some((c) => c.url === url)) return;
    if (unusableImage(url)) return reject(kind, url, source, "svg_unsafe");
    if (list === logos && size !== null && size < MIN_LOGO_PX) return reject(kind, url, source, "too_small");
    if (list.length >= cap) return reject(kind, url, source, "over_cap");
    list.push({ url, source, size });
  };
  const addColor = (raw: string | null, source: string) => {
    if (!raw) return;
    const c = normalizeColor(raw);
    if (!c) return;
    if (isNearWhiteOrBlack(c)) return reject("color", c, source, "near_white_or_black");
    const hex = withWhiteContrast(c);
    if (colors.some((x) => x.hex === hex)) return reject("color", c, source, "duplicate");
    if (colors.length >= MAX_COLORS) return reject("color", c, source, "over_cap");
    colors.push({ hex, original: c, source });
  };

  // ── the manifest (one guarded fetch) ──
  const linkTags = tags(html, "link");
  const manifestHref = linkTags.find((t) => relOf(t).includes("manifest"));
  const manifestUrl = manifestHref ? absoluteUrl(attr(manifestHref, "href"), origin) : null;
  let manifest: any = null;
  if (manifestUrl) {
    const text = await fetchText(manifestUrl, MANIFEST_MAX_BYTES).catch(() => null);
    try { manifest = text ? JSON.parse(text) : null; } catch { manifest = null; }
  }

  // ── logo ──
  const icons = linkTags
    .filter((t) => { const r = relOf(t); return r.includes("apple-touch-icon") || r.includes("apple-touch-icon-precomposed") || r.includes("icon"); })
    .map((t) => ({ href: attr(t, "href"), size: declaredSize(attr(t, "sizes")), apple: relOf(t).some((r) => r.startsWith("apple-touch-icon")) }))
    // Apple touch icons first (always at least 120px), then the largest declared.
    .sort((a, b) => Number(b.apple) - Number(a.apple) || (b.size ?? 0) - (a.size ?? 0));
  for (const i of icons) addImage(logos, i.href, i.apple ? "apple-touch-icon" : "icon", i.apple ? i.size ?? 180 : i.size, MAX_LOGOS);
  if (Array.isArray(manifest?.icons)) {
    const mIcons = [...manifest.icons]
      .filter((i: any) => i && typeof i.src === "string")
      .sort((a: any, b: any) => (declaredSize(b.sizes) ?? 0) - (declaredSize(a.sizes) ?? 0));
    for (const i of mIcons) addImage(logos, absoluteUrl(i.src, manifestUrl ?? origin), "manifest", declaredSize(i.sizes), MAX_LOGOS);
  }
  for (const t of tags(headerRegion(html), "img")) {
    const hay = `${attr(t, "src") ?? ""} ${attr(t, "alt") ?? ""} ${attr(t, "class") ?? ""} ${attr(t, "id") ?? ""}`;
    if (!/logo/i.test(hay)) continue;
    const w = Number(attr(t, "width")) || null;
    addImage(logos, imgSrc(t), "header-img", w, MAX_LOGOS);
  }
  const og = metaContent(html, "og:image") ?? metaContent(html, "og:image:secure_url") ?? metaContent(html, "twitter:image");
  addImage(logos, og, "og:image", null, MAX_LOGOS);

  // ── hero ──
  addImage(heroes, og, "og:image", null, MAX_HEROES);
  const heroBlock = /<(?:section|div)\b[^>]*\b(?:class|id)\s*=\s*["'][^"']*(?:hero|banner|slideshow|slider|carousel)[^"']*["'][^>]*>[\s\S]{0,8000}/i.exec(html);
  if (heroBlock) {
    for (const t of tags(heroBlock[0], "img")) {
      const w = Number(attr(t, "width")) || null;
      if (w !== null && w < 600) continue;
      addImage(heroes, imgSrc(t), "hero-img", w, MAX_HEROES);
    }
  }

  // ── colour ──
  addColor(metaContent(html, "theme-color"), "theme-color");
  if (typeof manifest?.theme_color === "string") addColor(manifest.theme_color, "manifest");
  const inlineCss = (html.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) ?? []).join("\n");
  const sheetUrls = linkTags
    .filter((t) => relOf(t).includes("stylesheet"))
    .map((t) => absoluteUrl(attr(t, "href"), origin))
    .filter((u): u is string => !!u)
    // The theme's own sheet first: plugins and fonts rarely hold the brand colour.
    .sort((a, b) => Number(/theme|style|main|app|custom/i.test(b)) - Number(/theme|style|main|app|custom/i.test(a)))
    .slice(0, STYLESHEETS_READ);
  const sheets = (await Promise.all(sheetUrls.map((u) => fetchText(u, STYLESHEET_MAX_BYTES).catch(() => null)))).filter((s): s is string => !!s);
  const css = [inlineCss, ...sheets].join("\n");
  for (const c of customPropertyColors(css)) addColor(c, "css-variable");
  addColor(buttonColor(css), "button");

  return { logos, colors, heroes, language: widgetLanguage(html), rejected };
}

// ── the hand-over to the AI service ──────────────────────────────────────────

const AI_SERVICE_URL = () => (process.env.AI_SERVICE_URL || "http://ai:4006").replace(/\/$/, "");
/** The whole pre-fill, model and image copies included, must end well before the Channels step. */
export const PREFILL_TIMEOUT_MS = 60_000;

/** What the scan learned, in the shape the pre-fill reads. */
export function prefillContext(report: any): Record<string, string | null> {
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const b = report?.brand ?? {};
  const biz = report?.business ?? {};
  const products = Array.isArray(biz.products) ? biz.products.map((p: any) => s(p?.name ?? p)).filter(Boolean).slice(0, 8).join(", ") : s(biz.products);
  return {
    businessName: s(biz.name),
    summary: s(biz.summary) ?? s(biz.description),
    products: products || null,
    voice: s(b.voice),
    tone: s(b.tone),
    greetingExample: s(b.greetingExample),
  };
}

export type PrefillPoster = (authorization: string, body: unknown) => Promise<{ status?: string; filled?: Record<string, unknown> } | null>;

export const postWidgetPrefill: PrefillPoster = async (authorization, body) => {
  const res = await fetch(`${AI_SERVICE_URL()}/api/ai-assist/widget-prefill`, {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PREFILL_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const json: any = await res.json().catch(() => null);
  return json?.data ?? null;
};

/**
 * Design the widget from the scan. Never throws: a failure is logged and the
 * widget keeps its defaults.
 */
export async function prefillWidgetFromScan(
  args: { authorization: string; origin: string; candidates: BrandCandidates | null; report: any },
  post: PrefillPoster = postWidgetPrefill,
): Promise<{ status?: string; filled?: Record<string, unknown> } | null> {
  try {
    const c = args.candidates ?? { logos: [], colors: [], heroes: [], language: null, rejected: [] };
    return await post(args.authorization, {
      domain: args.origin,
      language: c.language,
      logos: c.logos,
      colors: c.colors,
      heroes: c.heroes,
      context: prefillContext(args.report),
    });
  } catch (err: any) {
    console.warn(`[widget-prefill] ${args.origin}: ${err?.message ?? err}`);
    return null;
  }
}

// ── the console preview (platform admin) ─────────────────────────────────────

/** A typed site ("shop.co.il/about") as the https origin the scan reads, or null. */
export function previewOrigin(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v || v.length > 300) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    if (!u.hostname.includes(".")) return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** Without a full scan: what the home page says about the business. */
export function pageContext(page: { html: string; text: string; title?: string | null; siteName?: string | null }): Record<string, string | null> {
  const meta = (key: string) => {
    for (const t of page.html.match(/<meta\b[^>]*>/gi) ?? []) {
      const k = (attr(t, "property") ?? attr(t, "name") ?? "").toLowerCase();
      if (k === key) return attr(t, "content");
    }
    return null;
  };
  const description = meta("description") ?? meta("og:description");
  return {
    businessName: page.siteName || meta("og:site_name") || page.title || null,
    summary: [description, page.text.replace(/\s+/g, " ").slice(0, 500)].filter(Boolean).join(" | ") || null,
    products: null, voice: null, tone: null, greetingExample: null,
  };
}
