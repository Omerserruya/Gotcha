/**
 * The site crawl, and the deterministic signal extraction over what it reads.
 *
 * This is the LLM-free half of business discovery: a light same-origin crawl of
 * a business's public pages, plus a regex pass that detects the tech stack and
 * the channels it publishes. It was module-level inside
 * `routes/onboarding.ts`, reachable only by running onboarding.
 *
 * ── Why it moved, and why onboarding calls it ──
 *
 * Screen 11b needs "Scan again" outside onboarding. The tempting shortcut is a
 * second crawler for the rescan, and it is the wrong one: two crawlers sharing
 * a name drift, and then a rescan reports something the original scan would
 * never have found - or misses something it would. So there is ONE crawler, and
 * the onboarding flow goes through this module rather than keeping a copy.
 *
 * ── What belongs to a crawl, and therefore lives here ──
 *
 * Link discovery, the well-known candidate paths, the fetch cap and the
 * per-page text slices are all part of what "a crawl" MEANS here, so they are
 * inside `crawlSite` rather than at whichever route calls it. A caller that had
 * to reassemble them would be free to assemble them differently.
 *
 * Note the cap that matters is on FETCHES (16). The 8-page limit some callers
 * assume is applied later and elsewhere - `/discover-business` in services/ai
 * slices the pages it is handed - so the two are different numbers doing
 * different jobs.
 *
 * ── The fetcher is injectable, for one specific reason ──
 *
 * `safeFetch` blocks private and loopback addresses by design, so the crawl
 * cannot be pointed at a local fixture server and there is no offline way to
 * exercise the orchestration end to end. Injecting the page fetcher makes the
 * part that can actually drift - which URLs are requested, the dedupe, the cap,
 * the slicing - testable without a network, which is what let this extraction
 * be verified against a golden captured from the pre-extraction code rather
 * than by reading the diff.
 */
import { safeFetch } from "@chatcenter/shared";
import { promises as dns } from "dns";

/** Fetch a page returning BOTH raw HTML (for signal regexes) and stripped text
 *  (for the LLM). Best-effort - returns null on any failure. */
export async function fetchPageRaw(url: string, timeoutMs = 8000): Promise<{ html: string; text: string } | null> {
  try {
    // Present as a real browser. Many stores sit behind bot filters that 403 a
    // generic crawler UA - a partial/blocked fetch is a root cause of false
    // negatives, so we look like Chrome and send the browser header set.
    // SSRF-hardened: the crawl target is user-supplied, so safeFetch enforces
    // the scheme allowlist, blocks private/link-local/metadata addresses at
    // DNS resolution, and revalidates every redirect hop.
    const r = await safeFetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "he,en-US;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
      },
      timeoutMs,
    });
    if (!r.ok) return null;
    const ct = r.contentType || "";
    if (!ct.includes("text/html") && !ct.includes("xhtml")) return null;
    const html = r.text;
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/\s+/g, " ")
      .trim();
    return { html: html.slice(0, 400000), text };
  } catch {
    return null;
  }
}

// Same-origin internal links worth reading - the pages that carry a business's
// knowledge and policies. We only ever follow a handful.
// Link text / path keywords worth following - the pages where policies, contact
// details, and knowledge actually live. Bilingual (EN + HE) because Hebrew
// stores label these in Hebrew even when the slug is English.
export const LINK_KEYWORDS =
  /(about|faq|help|support|contact|shipping|deliver|return|refund|exchange|warranty|policy|policies|terms|privacy|legal|pricing|plans|q-?a|אודות|צור.?קשר|יצירת.?קשר|שאלות|עזרה|תמיכה|משלוח|החזר|החזרה|החזרות|ביטול|תקנון|מדיניות|פרטיות|אחריות|תנאי)/i;

// Well-known convention paths we always TRY even if not linked from the home
// page - most false negatives on Shopify/WordPress stores are policies that
// exist at a predictable URL but aren't in the top nav. fetchPageRaw returns
// null fast on a 404, so probing these is cheap.
export const CANDIDATE_PATHS = [
  "/policies/refund-policy", "/policies/shipping-policy", "/policies/terms-of-service",
  "/policies/privacy-policy", "/policies/legal-notice", "/policies/contact-information",
  "/pages/contact", "/pages/contact-us", "/pages/faq", "/pages/about", "/pages/about-us",
  "/pages/shipping", "/pages/returns", "/pages/warranty", "/pages/terms", "/pages/accessibility",
  "/contact", "/contact-us", "/faq", "/about", "/terms", "/privacy",
  "/shipping", "/returns", "/refund-policy", "/policies", "/help", "/support",
];

export function extractInternalLinks(html: string, origin: string, cap = 10): string[] {
  const originHost = (() => { try { return new URL(origin).hostname; } catch { return ""; } })();
  const out = new Set<string>();
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.size < cap * 4) {
    const href = m[1];
    const label = (m[2] || "").replace(/<[^>]+>/g, " ");
    if (!href) continue;
    let abs: URL;
    try { abs = new URL(href, origin); } catch { continue; }
    if (abs.hostname !== originHost) continue;
    if (!/^https?:$/.test(abs.protocol)) continue;
    if (LINK_KEYWORDS.test(decodeURIComponent(abs.pathname)) || LINK_KEYWORDS.test(label)) {
      abs.hash = "";
      out.add(abs.toString());
    }
  }
  return Array.from(out).slice(0, cap);
}

// ─── Structured signal extraction (deterministic, LLM-free) ──
//
// Platform detection is STRENGTH-SCORED so we can tell an ACTIVE platform
// (many strong signals - e.g. Shopify's CDN + theme + section markup) from a
// LEGACY ARTIFACT (a single stray "magento" string). The AI is handed the
// scores and told to trust the strongest, so an old tag never gets recommended
// as an equal.

interface PlatformDef { slug: string; name: string; patterns: RegExp[] }
const PLATFORM_DEFS: PlatformDef[] = [
  { slug: "shopify", name: "Shopify", patterns: [/cdn\.shopify\.com/i, /\/cdn\/shop\//i, /Shopify\.theme/i, /myshopify\.com/i, /x-shopify/i, /shopify-section/i, /window\.Shopify/i] },
  { slug: "woocommerce", name: "WooCommerce", patterns: [/wp-content\/plugins\/woocommerce/i, /woocommerce/i, /wc-block/i, /wc_add_to_cart/i] },
  { slug: "wix", name: "Wix", patterns: [/wixstatic\.com/i, /wix\.com/i, /X-Wix/i, /_wixCssStates/i, /wixapps/i] },
  { slug: "magento", name: "Magento", patterns: [/mage\/cookies/i, /Magento_/i, /\/static\/version\d+\/frontend/i, /mage-cache/i, /magento/i] },
  { slug: "bigcommerce", name: "BigCommerce", patterns: [/bigcommerce\.com/i, /stencil-utils/i] },
  { slug: "squarespace", name: "Squarespace", patterns: [/squarespace\.com/i, /static1\.squarespace/i, /SQUARESPACE_CONTEXT/i] },
  { slug: "webflow", name: "Webflow", patterns: [/webflow\.com/i, /w-webflow/i, /data-wf-/i] },
];
const TRACKING_DEFS: Array<{ slug: string; name: string; re: RegExp }> = [
  { slug: "google_analytics", name: "Google Analytics", re: /google-analytics\.com|googletagmanager\.com|gtag\(|_gaq/i },
  { slug: "meta_pixel", name: "Meta Pixel", re: /connect\.facebook\.net|fbq\(/i },
  { slug: "tiktok_pixel", name: "TikTok Pixel", re: /analytics\.tiktok\.com|ttq\./i },
  { slug: "hotjar", name: "Hotjar", re: /hotjar\.com|hjSiteSettings/i },
];
// Third-party tools / apps (incl. the Shopify ecosystem the recommender uses).
const TOOL_DEFS: Array<{ slug: string; name: string; re: RegExp; chat?: boolean }> = [
  { slug: "hubspot", name: "HubSpot", re: /hs-scripts\.com|js\.hs-|hubspot\.com|hsforms/i },
  { slug: "salesforce", name: "Salesforce", re: /salesforce\.com|force\.com|pardot/i },
  { slug: "zendesk", name: "Zendesk", re: /zendesk\.com|zdassets\.com/i, chat: true },
  { slug: "intercom", name: "Intercom", re: /intercom\.io|widget\.intercom/i, chat: true },
  { slug: "crisp", name: "Crisp", re: /crisp\.chat/i, chat: true },
  { slug: "tawk", name: "Tawk.to", re: /tawk\.to/i, chat: true },
  { slug: "gorgias", name: "Gorgias", re: /gorgias\.(com|chat)/i, chat: true },
  { slug: "tidio", name: "Tidio", re: /tidio\.co/i, chat: true },
  { slug: "drift", name: "Drift", re: /drift\.com/i, chat: true },
  { slug: "zopim", name: "Zopim", re: /zopim/i, chat: true },
  { slug: "stripe", name: "Stripe", re: /js\.stripe\.com|stripe\.com\/v3/i },
  { slug: "paypal", name: "PayPal", re: /paypal\.com\/sdk|paypalobjects/i },
  { slug: "calendly", name: "Calendly", re: /calendly\.com/i },
  { slug: "klaviyo", name: "Klaviyo", re: /klaviyo\.com|static\.klaviyo/i },
  { slug: "yotpo", name: "Yotpo", re: /yotpo\.com|staticw2\.yotpo/i },
  { slug: "judgeme", name: "Judge.me", re: /judge\.me|judgeme/i },
  { slug: "loox", name: "Loox", re: /loox\.io/i },
  { slug: "returngo", name: "ReturnGO", re: /returngo\.ai|returngo/i },
];

function collectMatches(re: RegExp, hay: string, group = 1, cap = 12): string[] {
  const out = new Set<string>();
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(hay)) && out.size < cap) { if (m[group]) out.add(m[group].trim()); }
  return Array.from(out);
}

const EMAIL_JUNK = /(sentry|wix(press)?|example\.com|\.png|\.jpg|\.gif|@2x|@3x|godaddy|schema\.org|sentry\.io|w3\.org|core\.js)/i;

export interface DiscoverySignals {
  emails: string[];
  phones: string[];
  whatsapp: string[];
  instagram: string[];
  facebook: string[];
  messenger: string[];
  telegram: string[];
  tiktok: string[];
  contactForm: boolean;
  liveChat: string | null;
  platform: { slug: string; name: string; strength: number } | null;
  otherPlatforms: Array<{ slug: string; name: string; strength: number }>;
  tracking: string[];
  tools: string[];
  social: string[];
  coverage: string[]; // URLs actually read
  /** email → "gmail" | "outlook" from an MX lookup of the email's domain. */
  emailProviders?: Record<string, string>;
}

/**
 * Which mail platform serves the found addresses - a deterministic MX lookup
 * per unique domain (google → Gmail/Workspace, outlook/microsoft → Microsoft
 * 365). Lets the briefing show the real provider logo and offer the matching
 * one-click connect. Best-effort: DNS failures simply yield no provider.
 */
export async function detectEmailProviders(emails: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const domains = Array.from(new Set(emails.map((e) => e.split("@")[1]).filter((d): d is string => !!d))).slice(0, 4);
  await Promise.all(domains.map(async (domain) => {
    try {
      const mx = await dns.resolveMx(domain);
      const hosts = mx.map((m) => m.exchange.toLowerCase()).join(" ");
      const provider = /google|gmail/.test(hosts) ? "gmail" : /outlook|microsoft|office365/.test(hosts) ? "outlook" : null;
      if (provider) for (const e of emails) if (e.toLowerCase().endsWith("@" + domain)) out[e] = provider;
    } catch { /* unresolvable domain - no provider claim */ }
  }));
  return out;
}

/** Parse JSON-LD blocks for org contact info + social profiles (sameAs). */
export function parseJsonLd(html: string): { emails: string[]; phones: string[]; social: string[] } {
  const emails = new Set<string>(), phones = new Set<string>(), social = new Set<string>();
  for (const block of collectMatches(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi, html, 1, 8)) {
    let data: any;
    try { data = JSON.parse(block); } catch { continue; }
    const nodes: any[] = Array.isArray(data) ? data : data["@graph"] && Array.isArray(data["@graph"]) ? data["@graph"] : [data];
    for (const n of nodes) {
      if (!n || typeof n !== "object") continue;
      if (typeof n.email === "string") emails.add(n.email.replace(/^mailto:/i, "").trim());
      if (typeof n.telephone === "string") phones.add(n.telephone.trim());
      const sa = n.sameAs;
      if (Array.isArray(sa)) sa.forEach((u: any) => typeof u === "string" && social.add(u));
      else if (typeof sa === "string") social.add(sa);
      const cp = n.contactPoint;
      const cps = Array.isArray(cp) ? cp : cp ? [cp] : [];
      for (const c of cps) { if (c?.telephone) phones.add(String(c.telephone).trim()); if (c?.email) emails.add(String(c.email).replace(/^mailto:/i, "").trim()); }
    }
  }
  return { emails: [...emails], phones: [...phones], social: [...social] };
}

export function extractSignals(pages: Array<{ url: string; html: string }>): DiscoverySignals {
  const html = pages.map((p) => p.html).join("\n");

  const emails = new Set<string>();
  collectMatches(/mailto:([^"'>?\s]+)/gi, html).forEach((e) => emails.add(decodeURIComponent(e).toLowerCase()));
  collectMatches(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, html, 0, 20).forEach((e) => emails.add(e.toLowerCase()));

  const phones = new Set<string>();
  collectMatches(/tel:(\+?[\d][\d\-\s().]{5,})/gi, html).forEach((p) => phones.add(p.replace(/[\s().]/g, "")));

  const whatsapp = new Set<string>();
  // Broadened so WhatsApp isn't silently dropped: classic wa.me / api links,
  // the whatsapp:// app scheme, and wa.link short links all count.
  [
    /wa\.me\/(\+?\d{6,15})/gi,
    /api\.whatsapp\.com\/send\?phone=(\d{6,15})/gi,
    /whatsapp[^"']*?phone=(\d{6,15})/gi,
    /whatsapp:\/\/send\?phone=(\+?\d{6,15})/gi,
    /wa\.link\/(\+?\d{6,15})/gi,
  ].forEach((re) => collectMatches(re, html).forEach((n) => whatsapp.add(n.replace(/^\+/, ""))));

  const handle = (re: RegExp, exclude: RegExp) =>
    collectMatches(re, html).filter((h) => !exclude.test(h));
  const instagram = handle(/instagram\.com\/([A-Za-z0-9_.]{2,40})/gi, /^(p|reel|reels|explore|accounts|stories|tv|about)$/i);
  const facebook = handle(/facebook\.com\/([A-Za-z0-9_.]{2,60})/gi, /^(sharer|tr|plugins|dialog|events|groups|profile\.php|permalink\.php|photo|login|help|policies|policy|terms|privacy|legal|about|business|ads|settings|watch|marketplace|gaming)$/i);
  const messenger = collectMatches(/m\.me\/([A-Za-z0-9_.]+)/gi, html);
  const telegram = handle(/t\.me\/([A-Za-z0-9_]{3,32})/gi, /^(share|joinchat)$/i);
  const tiktok = handle(/tiktok\.com\/@([A-Za-z0-9_.]{2,30})/gi, /^$/);

  const jsonld = parseJsonLd(html);
  jsonld.emails.forEach((e) => e && emails.add(e.toLowerCase()));
  jsonld.phones.forEach((p) => p && phones.add(p.replace(/[\s().]/g, "")));

  // Platform strength scoring.
  const scored = PLATFORM_DEFS
    .map((d) => ({ slug: d.slug, name: d.name, strength: d.patterns.reduce((s, re) => s + (re.test(html) ? 1 : 0), 0) }))
    .filter((p) => p.strength > 0)
    .sort((a, b) => b.strength - a.strength);
  const platform = scored[0] || null;
  const otherPlatforms = scored.slice(1);

  const tracking = TRACKING_DEFS.filter((t) => t.re.test(html)).map((t) => t.slug);
  const matchedTools = TOOL_DEFS.filter((t) => t.re.test(html));
  const tools = matchedTools.map((t) => t.slug);
  const liveChat = matchedTools.find((t) => t.chat)?.name || null;

  const contactForm = /<form[\s\S]{0,6000}(contact|message|inquir|נשמח|צור.?קשר|שליחה|get in touch)/i.test(html);

  const social = new Set<string>(jsonld.social);
  instagram.forEach((h) => social.add(`https://instagram.com/${h}`));
  facebook.forEach((h) => social.add(`https://facebook.com/${h}`));

  const clean = (arr: string[]) => arr.filter((e) => !EMAIL_JUNK.test(e));
  return {
    emails: clean([...emails]).slice(0, 8),
    phones: [...phones].slice(0, 6),
    whatsapp: [...whatsapp].slice(0, 4),
    instagram: instagram.slice(0, 4),
    facebook: facebook.slice(0, 4),
    messenger: messenger.slice(0, 3),
    telegram: telegram.slice(0, 3),
    tiktok: tiktok.slice(0, 3),
    contactForm,
    liveChat,
    platform,
    otherPlatforms,
    tracking,
    tools,
    social: [...social].slice(0, 10),
    coverage: pages.map((p) => p.url),
  };
}

/** Call the AI service to run the deep 5-domain LLM scan. Forwards the admin
 *  JWT exactly like callAIGenerateConfigs. Returns the report or null. */
const ECOM_PLATFORMS = new Set(["shopify", "woocommerce", "magento", "bigcommerce", "prestashop", "wix_stores", "squarespace_commerce", "ecwid", "shopware", "opencart"]);

export function classifyBusinessType(text: string, signals: DiscoverySignals): string {
  const t = (text || "").toLowerCase();
  const plat = (signals.platform?.slug || "").toLowerCase();
  const has = (...ws: string[]) => ws.some((w) => t.includes(w));
  if (ECOM_PLATFORMS.has(plat) || has("add to cart", "add to bag", "checkout", "free shipping", "in stock", "sold out", "my cart", "shopping cart", "עגלה", "הוסף לסל", "משלוח חינם", "לרכישה")) return "ecommerce";
  if (has("law firm", "attorney", "lawyer", "litigation", "practice areas", "legal services", "counsel", "עורך דין", "עורכי דין", "ייעוץ משפטי", "משרד עורכי")) return "legal";
  if (has("free trial", "start free", "start for free", "/pricing", "api documentation", "integrations", "sign up free", "our platform", "software platform", "for developers", "open source")) return "saas";
  if (has("event venue", "event space", "wedding venue", "banquet", "event hall", "host your event", "weddings", "corporate events", "our venue", "book the venue", "אולם אירועים", "גן אירועים", "אולמי אירועים", "חתונות", "בר מצווה", "בת מצווה", "הפקת אירועים", "קייטרינג לאירועים")) return "events";
  if (has("book now", "tours", "vacation", "itinerary", "destinations", "guided tour", "travel", "book your", "טיול", "חופשה", "יעדים", "הזמנת מקום")) return "tourism";
  if (has("view menu", "our menu", "reservation", "reserve a table", "order online", "delivery & pickup", "restaurant", "תפריט", "הזמנת שולחן", "משלוחים", "מסעדה")) return "restaurant";
  if (has("book an appointment", "clinic", "our patients", "treatment", "our doctors", "medical", "dental", "מרפאה", "לקביעת תור", "טיפול", "רופא")) return "health";
  if (has("properties", "listings", "for sale", "for rent", "real estate", "square feet", 'נדל"ן', "דירות", "להשכרה", "למכירה")) return "realestate";
  return "generic";
}

// [key, English, Hebrew] - each step is a genuine phase of the scan.
// ─── The crawl itself ────────────────────────────────────────

export interface CrawledPage { url: string; html: string; text: string }

export interface SiteCrawl {
  /** The home page, raw and stripped. */
  home: { html: string; text: string };
  /** Same-origin pages that answered, with their HTML kept for signal regexes. */
  okPages: CrawledPage[];
  /** Exactly the shape `/api/ai-assist/discover-business` expects. */
  pages: Array<{ url: string; text: string }>;
  signals: DiscoverySignals;
  businessType: string;
  /** Every URL the crawl asked for, in order. Useful to a caller reporting progress. */
  requested: string[];
  /**
   * How many of `pages` carry DISTINCT text.
   *
   * ★ NOT cosmetic, and the reason it exists is a real site. A
   * password-protected Shopify store answers 200 to EVERY path - including
   * /policies/refund-policy and /pages/contact - with the same login page.
   * `fetchPageRaw` only rejects a non-200 or a non-HTML body, so all 17 fetches
   * "succeed" and the crawl reads one page seventeen times.
   *
   * Measured on the dev tenant's own store: 17 requested, 17 returned,
   * distinctTextPages = 1, 188 characters each, reading "This store is password
   * protected".
   *
   * So a caller must never say "we read 17 pages of your site" off
   * `pages.length`. When this is 1 the honest sentence is that the site could
   * not be read, and `businessType` will still say "ecommerce" because the
   * Shopify markers are in the login page's own markup - a confident answer
   * about a site nobody saw.
   *
   * Reported rather than acted on deliberately: deduplicating `pages` would
   * change what onboarding sends to the model for every new tenant, and that is
   * a behaviour change to decide on its own, not a side effect of a diagnostic.
   */
  distinctTextPages: number;
}

/** Which beat of the crawl is running, for callers that narrate it to a user. */
export type CrawlPhase = "homepage" | "pages" | "signals";

export type PageFetcher = (url: string, timeoutMs?: number) => Promise<{ html: string; text: string } | null>;

/** Total page fetches after the home page. Politeness, not a page-count limit. */
export const CRAWL_FETCH_CAP = 16;

/**
 * Crawl a site and extract what can be known without a model.
 *
 * Returns null when the home page cannot be read at all - the caller decides
 * what that means, because onboarding reports it as a failed scan while a
 * rescan may simply leave the previous answer standing.
 */
export async function crawlSite(
  origin: string,
  opts: { fetchPage?: PageFetcher; onPhase?: (phase: CrawlPhase) => void | Promise<void> } = {},
): Promise<SiteCrawl | null> {
  const fetchPage = opts.fetchPage ?? fetchPageRaw;
  const phase = async (p: CrawlPhase) => { try { await opts.onPhase?.(p); } catch { /* narration must never fail a crawl */ } };
  const requested: string[] = [];

  await phase("homepage");
  requested.push(origin);
  const home = await fetchPage(origin);
  if (!home) return null;

  await phase("pages");
  // Discovered links AND well-known convention paths: most "missing" policies
  // live in the footer or at a predictable URL, not on the home page, and a
  // miss returns null fast so probing is cheap.
  const discovered = extractInternalLinks(home.html, origin, 10);
  const candidates = CANDIDATE_PATHS
    .map((p) => { try { return new URL(p, origin).toString(); } catch { return null; } })
    .filter((u): u is string => !!u);
  const toFetch = Array.from(new Set([...discovered, ...candidates]))
    .filter((u) => u !== origin && u !== origin + "/")
    .slice(0, CRAWL_FETCH_CAP);

  const fetched = (await Promise.all(toFetch.map((u) => fetchPage(u, 6000)))).map((page, i) => ({ url: toFetch[i]!, page }));
  requested.push(...toFetch);
  const okPages: CrawledPage[] = fetched
    .filter((e) => e.page)
    .map((e) => ({ url: e.url, html: e.page!.html, text: e.page!.text }));

  // Capped so the JSON body stays under the AI service's body-parser limit.
  // The AI trims further when it builds the LLM corpus.
  const pages = [
    { url: origin, text: home.text.slice(0, 9000) },
    ...okPages.map((e) => ({ url: e.url, text: e.text.slice(0, 2800) })),
  ];

  await phase("signals");
  const signals = extractSignals([{ url: origin, html: home.html }, ...okPages]);
  signals.emailProviders = await detectEmailProviders(signals.emails);

  // Classify deterministically from the business's own pages, so the LLM,
  // the health read and the gaps all reason about the RIGHT kind of business.
  const businessType = classifyBusinessType([home.text, ...okPages.map((p) => p.text)].join(" "), signals);

  return {
    home,
    okPages,
    pages,
    signals,
    businessType,
    requested,
    distinctTextPages: new Set(pages.map((p) => p.text)).size,
  };
}
