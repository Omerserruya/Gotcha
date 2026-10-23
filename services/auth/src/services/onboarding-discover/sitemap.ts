/**
 * Which pages the scan reads, and in what order.
 *
 * The site's own sitemap (and the ones robots.txt names) is the list of what
 * exists; the old crawl guessed from 10 home-page links and 29 conventional
 * paths. Pages are scored by how much an AI employee needs them - policies
 * first, then FAQ, about, contact, shipping and returns, products last - and
 * capped, so a 5,000-product store costs the same as a 20-page one.
 *
 * robots.txt Disallow rules for "*" are honoured. Polite by construction: the
 * plan is bounded and the reader fetches a few at a time.
 */
import type { Fetcher } from "./harvest";
import { defaultFetcher } from "./harvest";

export const PAGE_CAP = 50;
const MAX_SITEMAP_FILES = 8;
const MAX_LOCS = 5000;

export interface RobotsRules { sitemaps: string[]; disallow: string[] }

/** The "*" group's Disallow prefixes and every Sitemap line. Unknown syntax is ignored, never fatal. */
export function parseRobots(text: string): RobotsRules {
  const sitemaps: string[] = [];
  const disallow: string[] = [];
  let inStar = false;
  let sawRuleInGroup = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (field === "sitemap") { if (value) sitemaps.push(value); continue; }
    if (field === "user-agent") {
      // Consecutive user-agent lines share one group.
      if (sawRuleInGroup) { inStar = false; sawRuleInGroup = false; }
      if (value === "*") inStar = true;
      continue;
    }
    if (field === "disallow" || field === "allow") {
      sawRuleInGroup = true;
      if (inStar && field === "disallow" && value) disallow.push(value);
    }
  }
  return { sitemaps, disallow };
}

export function allowedByRobots(url: string, rules: RobotsRules): boolean {
  let path: string;
  try { const u = new URL(url); path = u.pathname + u.search; } catch { return false; }
  return !rules.disallow.some((d) => {
    if (d.includes("*") || d.endsWith("$")) {
      // "*" is any run of characters; a trailing "$" anchors the end. Everything else is literal.
      const anchored = d.endsWith("$");
      const body = (anchored ? d.slice(0, -1) : d)
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
      return new RegExp("^" + body + (anchored ? "$" : "")).test(path);
    }
    return path.startsWith(d);
  });
}

export function locsOf(xml: string): { urls: string[]; sitemaps: string[] } {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const locs: string[] = [];
  const re = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) && locs.length < MAX_LOCS) locs.push(m[1]!.replace(/&amp;/g, "&").trim());
  return isIndex ? { urls: [], sitemaps: locs } : { urls: locs, sitemaps: [] };
}

/** Page kinds, by what the URL says it is. Hebrew slugs count. */
export type PageKind = "policy" | "faq" | "about" | "contact" | "shipping" | "returns" | "help" | "page" | "product" | "collection" | "blog" | "other";

const KIND_RULES: Array<[PageKind, RegExp]> = [
  ["returns", /(return|refund|exchange|החזר|החזרה|החזרות|החלפ|ביטול)/i],
  ["shipping", /(shipping|delivery|משלוח|משלוחים)/i],
  ["policy", /(\/policies\/|polic|terms|privacy|warranty|legal|takanon|תקנון|מדיניות|פרטיות|אחריות|תנאי)/i],
  ["faq", /(faq|q-?a|questions|שאלות)/i],
  ["about", /(about|our-story|אודות|הסיפור)/i],
  ["contact", /(contact|צור.?קשר|יצירת.?קשר)/i],
  ["help", /(help|support|עזרה|תמיכה)/i],
  ["product", /\/products?\/[^/]+|\/product-page\/|\/item\//i],
  ["collection", /\/collections?\/|\/category\/|\/product-category\//i],
  ["blog", /\/blogs?\/|\/news\/|\/articles?\//i],
  ["page", /\/pages?\//i],
];

export const KIND_PRIORITY: Record<PageKind, number> = {
  policy: 100, returns: 98, shipping: 96, faq: 90, about: 80, contact: 75, help: 70,
  page: 40, product: 20, collection: 10, blog: 8, other: 15,
};

export function kindOf(url: string): PageKind {
  let path: string;
  try { path = decodeURIComponent(new URL(url).pathname); } catch { return "other"; }
  if (path === "/" || path === "") return "page";
  for (const [kind, re] of KIND_RULES) if (re.test(path)) return kind;
  return "other";
}

export interface PlannedPage { url: string; kind: PageKind; score: number }

/**
 * The reading plan: home first, the platform's own policy pages next, then
 * sitemap pages by priority. Products are read only when the platform feed did
 * not already describe them (and then only a few, for the catalogue's shape).
 */
export function planPages(input: {
  origin: string;
  sitemapUrls: string[];
  platformPolicyUrls: string[];
  haveProductFeed: boolean;
  robots: RobotsRules;
  cap?: number;
  /**
   * The site's main language ("he"). When both /he/x and /x are listed, the
   * copy in that language is kept: brand voice must come from what customers
   * read. Otherwise the unprefixed copy is kept.
   */
  preferLang?: string;
}): PlannedPage[] {
  const cap = input.cap ?? PAGE_CAP;
  const host = new URL(input.origin).hostname.replace(/^www\./, "");
  const norm = (u: string): string | null => {
    try {
      const x = new URL(u, input.origin);
      if (x.hostname.replace(/^www\./, "") !== host) return null;
      x.hash = "";
      // Tracking and sort params make one page look like many.
      for (const p of [...x.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref|sort|variant)/i.test(p)) x.searchParams.delete(p);
      return x.toString().replace(/\/$/, "");
    } catch { return null; }
  };

  const seen = new Set<string>();
  const out: PlannedPage[] = [];
  const add = (u: string, kind: PageKind, score: number) => {
    const n = norm(u);
    if (!n || seen.has(n) || !allowedByRobots(n, input.robots)) return;
    seen.add(n);
    out.push({ url: n, kind, score });
  };

  add(input.origin, "page", 1000);
  for (const u of input.platformPolicyUrls) add(u, kindOf(u) === "other" ? "policy" : kindOf(u), 500);

  // A language-prefixed copy of a page that is also listed without the prefix
  // (/he/about next to /about) is usually the same document on sites that
  // switch language in the browser - measured: 18 of 48 fetches on a real
  // site came back identical. Read the unprefixed one only.
  // The home page is always read, so /he is a copy of it too.
  const listed = new Set([input.origin, ...input.sitemapUrls].map((u) => norm(u)).filter((u): u is string => !!u));
  const pref = (input.preferLang ?? "").toLowerCase();
  const langCopy = (u: string): boolean => {
    try {
      const x = new URL(u);
      const m = /^\/(he|en|ar|ru|fr|es|de|it)(\/.*)?$/i.exec(x.pathname);
      if (m) {
        // A copy in the preferred language is the one to keep.
        if (pref && m[1]!.toLowerCase() === pref) return false;
        x.pathname = m[2] || "/";
        return listed.has(x.toString().replace(/\/$/, ""));
      }
      // An unprefixed page whose preferred-language copy is listed gives way to it.
      if (!pref) return false;
      const copy = new URL(u);
      copy.pathname = `/${pref}${x.pathname === "/" ? "" : x.pathname}`;
      return listed.has(copy.toString().replace(/\/$/, ""));
    } catch { return false; }
  };

  const ranked = input.sitemapUrls
    .filter((u) => { const n = norm(u); return !n || !langCopy(n); })
    .map((u) => ({ u, kind: kindOf(u) }))
    .map(({ u, kind }) => ({ u, kind, score: KIND_PRIORITY[kind] - Math.min(20, (u.match(/\//g)?.length ?? 0)) }))
    .sort((a, b) => b.score - a.score);

  let products = 0;
  const productCap = input.haveProductFeed ? 0 : 8;
  for (const { u, kind, score } of ranked) {
    if (out.length >= cap) break;
    if (kind === "product") { if (products >= productCap) continue; products++; }
    if (kind === "collection" || kind === "blog") continue;
    add(u, kind, score);
  }
  return out.slice(0, cap);
}

/** robots.txt, then every sitemap it names (or /sitemap.xml), indexes followed one level down. */
export async function discoverSitemapUrls(origin: string, fetch: Fetcher = defaultFetcher): Promise<{ urls: string[]; robots: RobotsRules; files: number }> {
  const robotsRes = await fetch(new URL("/robots.txt", origin).toString(), { accept: "text/plain", timeoutMs: 6000 });
  const robots = robotsRes?.ok ? parseRobots(robotsRes.text) : { sitemaps: [], disallow: [] };
  // WordPress core publishes /wp-sitemap.xml and Yoast /sitemap_index.xml, and
  // robots.txt often names neither (our own Woo test store, 2026-10-23).
  const fallbacks = ["/sitemap.xml", "/wp-sitemap.xml", "/sitemap_index.xml"].map((p) => new URL(p, origin).toString());
  const queue = robots.sitemaps.length ? [...robots.sitemaps] : [...fallbacks];
  const urls: string[] = [];
  let files = 0;
  const visited = new Set<string>();
  while (queue.length && files < MAX_SITEMAP_FILES && urls.length < MAX_LOCS) {
    // Product and image sitemaps last: pages and policies matter more and the cap is shared.
    queue.sort((a, b) => Number(/product|image|collection/i.test(a)) - Number(/product|image|collection/i.test(b)));
    const next = queue.shift()!;
    if (visited.has(next)) continue;
    visited.add(next);
    const r = await fetch(next, { accept: "application/xml,text/xml;q=0.9,*/*;q=0.5", timeoutMs: 10_000 });
    files++;
    if (!r?.ok) continue;
    const { urls: u, sitemaps } = locsOf(r.text);
    urls.push(...u);
    queue.push(...sitemaps);
    // One answering fallback is the sitemap; the others are the same list again.
    if ((u.length || sitemaps.length) && fallbacks.includes(next)) {
      for (const f of fallbacks) { const i = queue.indexOf(f); if (i >= 0) queue.splice(i, 1); }
    }
  }
  return { urls, robots, files };
}
