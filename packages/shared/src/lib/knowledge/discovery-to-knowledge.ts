/**
 * Turns a `BusinessDiscovery` record (plus the profile and the readiness
 * answers) into the topic-based Knowledge Base entries an AI employee can
 * actually retrieve.
 *
 * The input columns are `Json`, written by several producers at different
 * points in a scan, so every field here is read defensively - see
 * `business-discovery-shape.ts` for the same lesson learned the hard way. A
 * missing domain produces NO entry rather than an entry that says "undefined";
 * an employee reciting "Our shipping policy is undefined" is worse than one
 * that says it doesn't know.
 *
 * Prose, not JSON. The body of each entry is written the way a colleague would
 * explain it, because it is retrieved as context for a language model and
 * pasted into a prompt. Dumping the raw discovery object in here would embed
 * key names and punctuation instead of meaning, and retrieval quality would
 * collapse.
 */

import {
  buildEntry,
  checksumOf,
  normalizeContent,
  normalizeUrl,
  type KbSourceType,
  type KbTopic,
  type ProjectedEntry,
} from "./onboarding-projection";

// ─── Defensive readers ──────────────────────────────────────

function obj(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/**
 * Sentinels the discovery synthesis writes when it did NOT find something.
 *
 * The LLM step fills every field it was asked for, so an unknown country comes
 * back as the literal string "unknown" rather than null. Rendering that
 * verbatim produces "Country: unknown" in the knowledge base, and the employee
 * then answers a customer with it - the same class of failure as reciting
 * "undefined". Treat them as absent, which also lets an entry that consists
 * only of sentinels be dropped entirely.
 */
const SENTINELS = new Set([
  "unknown", "n/a", "na", "none", "null", "undefined", "not specified",
  "not found", "not available", "unspecified", "-", "--", "?", "tbd",
  "לא ידוע", "לא צוין", "לא רלוונטי", "אין",
]);

function str(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const v = raw.trim();
  return SENTINELS.has(v.toLowerCase()) ? "" : v;
}

function list(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (typeof item === "string") return str(item);
      if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        const name = str(o.name) || str(o.label) || str(o.title);
        const detail = str(o.description) || str(o.detail) || str(o.value);
        if (name && detail) return `${name}: ${detail}`;
        return name || detail;
      }
      return "";
    })
    .filter(Boolean);
}

/** A section only earns its place if it actually has content. */
function section(heading: string, body: string | string[]): string {
  const lines = Array.isArray(body) ? body.filter(Boolean) : [body].filter(Boolean);
  if (!lines.length) return "";
  const rendered = Array.isArray(body) ? lines.map((l) => `- ${l}`).join("\n") : lines[0];
  return `## ${heading}\n${rendered}`;
}

function join(parts: string[]): string {
  return parts.filter(Boolean).join("\n\n").trim();
}

// ─── Inputs ─────────────────────────────────────────────────

export interface DiscoveryInput {
  websiteDomain?: string | null;
  brand?: unknown;
  business?: unknown;
  knowledge?: unknown;
  communication?: unknown;
  technology?: unknown;
}

export interface ProfileInput {
  organizationName?: string | null;
  industry?: string | null;
  businessDescription?: string | null;
  country?: string | null;
  primaryLanguage?: string | null;
}

export interface ReadinessAnswer {
  question: string;
  answer: string;
  topic?: KbTopic;
}

export interface PageInput {
  url: string;
  title?: string | null;
  content: string;
  /** The page's own <link rel="canonical">, when it has one. */
  canonical?: string | null;
  /** The site's home page: kept whole when the shared header/footer is removed. */
  home?: boolean;
  /** The site's own name (og:site_name or the title's first part); titles the home page. */
  siteName?: string | null;
}

export interface ExternalSourceInput {
  /** Stable per-source identifier: the file id, the Drive file id. */
  externalId: string;
  title: string;
  content: string;
  sourceType: Extract<KbSourceType, "file" | "drive">;
  sourceUrl?: string;
}

export interface ProjectionContext {
  language: string;
  /** ISO timestamp; injected so the projection stays deterministic in tests. */
  now: string;
}

// ─── Titles ─────────────────────────────────────────────────
// Bilingual, because the KB list is a customer-facing surface and a Hebrew
// tenant should not find eleven English rows in their knowledge base.

const TITLES: Record<KbTopic, { en: string; he: string }> = {
  business_overview: { en: "Business overview", he: "סקירת העסק" },
  products_services: { en: "Products and services", he: "מוצרים ושירותים" },
  support_info: { en: "Customer support information", he: "מידע לתמיכת לקוחות" },
  shipping_returns: { en: "Shipping, returns and cancellations", he: "משלוחים, החזרות וביטולים" },
  pricing_policies: { en: "Pricing and commercial policies", he: "תמחור ומדיניות מסחרית" },
  contact_hours: { en: "Contact details and opening hours", he: "פרטי קשר ושעות פעילות" },
  faq: { en: "Frequently asked questions", he: "שאלות נפוצות" },
  brand_voice: { en: "Brand voice and communication style", he: "שפת המותג וסגנון תקשורת" },
  processes: { en: "Internal operational processes", he: "תהליכים תפעוליים פנימיים" },
  website_pages: { en: "Website page", he: "עמוד באתר" },
  readiness_answers: { en: "Answers you provided", he: "תשובות שמסרתם" },
};

export function titleFor(topic: KbTopic, language: string): string {
  const entry = TITLES[topic];
  return isHe(language) ? entry.he : entry.en;
}

function isHe(language: string): boolean {
  return !!language && language.toLowerCase().startsWith("he");
}

/**
 * Section headings inside an entry's body.
 *
 * These are localized for the same reason the titles are: the body is the text
 * a Hebrew-speaking customer's employee quotes back to them, and an entry whose
 * title is "סקירת העסק" but whose headings read "## Who we are" is a
 * half-translated document. It is also what the retrieval embedding sees, so
 * matching the tenant's language improves the match for their own questions.
 */
const HEADINGS = {
  who_we_are: { en: "Who we are", he: "מי אנחנו" },
  what_we_do: { en: "What we do", he: "מה אנחנו עושים" },
  value_prop: { en: "Value proposition", he: "הצעת הערך" },
  business_model: { en: "Business model", he: "מודל עסקי" },
  who_we_serve: { en: "Who we serve", he: "למי אנחנו פונים" },
  products: { en: "Products", he: "מוצרים" },
  services: { en: "Services", he: "שירותים" },
  pricing_model: { en: "Pricing model", he: "מודל תמחור" },
  terms: { en: "Terms", he: "תנאים" },
  shipping: { en: "Shipping", he: "משלוחים" },
  returns: { en: "Returns", he: "החזרות" },
  refunds: { en: "Refunds", he: "זיכויים" },
  cancellations: { en: "Cancellations", he: "ביטולים" },
  help_centre: { en: "Help centre", he: "מרכז העזרה" },
  documentation: { en: "Documentation", he: "תיעוד" },
  privacy: { en: "Privacy", he: "פרטיות" },
  contact: { en: "How to reach us", he: "איך ליצור איתנו קשר" },
  faq: { en: "Frequently asked questions", he: "שאלות נפוצות" },
  voice: { en: "Voice", he: "קול" },
  tone: { en: "Tone", he: "טון" },
  style: { en: "Style", he: "סגנון" },
  positioning: { en: "Positioning", he: "מיצוב" },
  vocabulary: { en: "Preferred vocabulary", he: "מילים מועדפות" },
  forbidden: { en: "Never use these words", he: "מילים אסורות" },
  languages: { en: "Languages", he: "שפות" },
  fields: { en: "Details", he: "פרטים" },
} as const;

type HeadingKey = keyof typeof HEADINGS;

/** Per-projection heading translator. */
function headings(language: string) {
  const he = isHe(language);
  return (key: HeadingKey) => (he ? HEADINGS[key].he : HEADINGS[key].en);
}

/** Labels used inside the overview bullet list. */
const FIELD_LABELS = {
  name: { en: "Name", he: "שם" },
  industry: { en: "Industry", he: "תחום" },
  country: { en: "Country", he: "מדינה" },
  website: { en: "Website", he: "אתר" },
} as const;

function fieldLabel(key: keyof typeof FIELD_LABELS, language: string): string {
  return isHe(language) ? FIELD_LABELS[key].he : FIELD_LABELS[key].en;
}

// ─── Topic bodies ───────────────────────────────────────────

type Build = (d: DiscoveryInput, p: ProfileInput, lang: string) => string;

function businessOverview(d: DiscoveryInput, p: ProfileInput, lang: string): string {
  const h = headings(lang);
  const b = obj(d.business);
  const industry = str(p.industry) || str(b.industry);
  const domain = str(d.websiteDomain || "");
  return join([
    section(h("who_we_are"), [
      str(p.organizationName) && `${fieldLabel("name", lang)}: ${str(p.organizationName)}`,
      industry && `${fieldLabel("industry", lang)}: ${industry}`,
      str(p.country) && `${fieldLabel("country", lang)}: ${str(p.country)}`,
      domain && `${fieldLabel("website", lang)}: ${domain}`,
    ].filter(Boolean) as string[]),
    section(h("what_we_do"), str(b.summary) || str(p.businessDescription)),
    section(h("value_prop"), str(b.valueProp)),
    section(h("business_model"), str(b.businessModel)),
    section(h("who_we_serve"), list(b.personas).length ? list(b.personas) : (str(b.icp) ? [str(b.icp)] : [])),
  ]);
}

function productsServices(d: DiscoveryInput, _p: ProfileInput, lang: string): string {
  const h = headings(lang);
  const b = obj(d.business);
  return join([
    section(h("products"), list(b.products)),
    section(h("services"), list(b.services)),
  ]);
}

function pricingPolicies(d: DiscoveryInput, _p: ProfileInput, lang: string): string {
  const h = headings(lang);
  const b = obj(d.business);
  const k = obj(obj(d.knowledge).policies);
  return join([
    section(h("pricing_model"), str(b.pricingModel)),
    section(h("terms"), str(k.terms)),
  ]);
}

function shippingReturns(d: DiscoveryInput, _p: ProfileInput, lang: string): string {
  const h = headings(lang);
  const k = obj(obj(d.knowledge).policies);
  return join([
    section(h("shipping"), str(k.shipping)),
    section(h("returns"), str(k.returns)),
    section(h("refunds"), str(k.refunds)),
    section(h("cancellations"), str(k.cancellations)),
  ]);
}

function supportInfo(d: DiscoveryInput, _p: ProfileInput, lang: string): string {
  const h = headings(lang);
  const k = obj(d.knowledge);
  return join([
    section(h("help_centre"), str(k.helpCenter)),
    section(h("documentation"), str(k.docs)),
    section(h("privacy"), str(obj(k.policies).privacy)),
  ]);
}

/** Contact channel types as people say them; an unknown type is humanized, never printed raw. */
const CHANNEL_LABELS: Record<string, { en: string; he: string }> = {
  phone: { en: "Phone", he: "טלפון" },
  mobile: { en: "Mobile", he: "נייד" },
  whatsapp: { en: "WhatsApp", he: "WhatsApp" },
  email: { en: "Email", he: "אימייל" },
  contact_form: { en: "Contact form", he: "טופס יצירת קשר" },
  form: { en: "Contact form", he: "טופס יצירת קשר" },
  live_chat: { en: "Live chat", he: "צ'אט באתר" },
  chat: { en: "Chat", he: "צ'אט" },
  address: { en: "Address", he: "כתובת" },
  store: { en: "Store", he: "חנות" },
  instagram: { en: "Instagram", he: "Instagram" },
  facebook: { en: "Facebook", he: "Facebook" },
};

function channelLabel(type: string, lang: string): string {
  const key = type.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const known = CHANNEL_LABELS[key];
  if (known) return isHe(lang) ? known.he : known.en;
  const words = key.replace(/_+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "";
}

/**
 * A line is a fact only with something a customer can use: a number, an
 * address, a link. "contact_form - (General inquiries)" told them nothing.
 */
function isConcreteContact(detail: string): boolean {
  return /[@]|\d{3,}|https?:\/\/|www\.|\.[a-z]{2,}\b/i.test(detail) || detail.trim().length >= 12;
}

function contactHours(d: DiscoveryInput, _p: ProfileInput, lang: string): string {
  const h = headings(lang);
  const channels = Array.isArray(obj(d.communication).channels)
    ? (obj(d.communication).channels as unknown[])
    : [];
  const lines = channels
    .map((c) => {
      const o = obj(c);
      const type = str(o.type);
      const detail = str(o.identifier) || str(o.detail);
      const purpose = str(o.purpose);
      if (!detail || !isConcreteContact(detail)) return "";
      return [channelLabel(type, lang), detail, purpose && `(${purpose})`].filter(Boolean).join(" - ");
    })
    .filter(Boolean);
  return join([section(h("contact"), lines)]);
}

function faq(d: DiscoveryInput, _p: ProfileInput, lang: string): string {
  const h = headings(lang);
  const k = obj(d.knowledge);
  const raw = k.faq;
  if (typeof raw === "string") return join([section(h("faq"), str(raw))]);
  if (Array.isArray(raw)) {
    const pairs = raw
      .map((item) => {
        const o = obj(item);
        const q = str(o.question) || str(o.q);
        const a = str(o.answer) || str(o.a);
        return q && a ? `**${q}**\n${a}` : "";
      })
      .filter(Boolean);
    return pairs.length ? `## ${h("faq")}\n\n${pairs.join("\n\n")}` : "";
  }
  return "";
}

function brandVoice(d: DiscoveryInput, _p: ProfileInput, lang: string): string {
  const h = headings(lang);
  const b = obj(d.brand);
  const forbidden = list(b.forbiddenWords);
  return join([
    section(h("voice"), str(b.voice)),
    section(h("tone"), str(b.tone)),
    section(h("style"), str(b.style)),
    section(h("positioning"), str(b.positioning)),
    section(h("vocabulary"), list(b.vocabulary)),
    forbidden.length ? section(h("forbidden"), forbidden) : "",
    section(h("languages"), list(b.languages)),
  ]);
}

const TOPIC_BUILDERS: Array<{ topic: KbTopic; build: Build }> = [
  { topic: "business_overview", build: businessOverview },
  { topic: "products_services", build: productsServices },
  { topic: "support_info", build: supportInfo },
  { topic: "shipping_returns", build: shippingReturns },
  { topic: "pricing_policies", build: pricingPolicies },
  { topic: "contact_hours", build: contactHours },
  { topic: "faq", build: faq },
  { topic: "brand_voice", build: brandVoice },
];

// ─── Public projection ──────────────────────────────────────

/**
 * Topic summaries synthesized from the scan. Empty topics are skipped
 * entirely: an entry whose body is a lone heading teaches the employee
 * nothing and pollutes retrieval with a near-empty chunk.
 */
/**
 * Policy-type topics need a real fact to be a document (2026-10-14). On dev a
 * "Contact details" doc held a raw slug and "Pricing" one generic line
 * ("retail prices shown per product"): a customer opening Knowledge sees a doc
 * that says nothing. A fact here is something checkable: a number (a price, a
 * day count, an hour), an email, a link. Length is not the test: "Returns
 * within 14 days." is short and real. Without one, the topic is skipped and
 * reported, so the screen shows a gap.
 */
export function hasConcreteFact(content: string): boolean {
  const body = content.split("\n").filter((line) => !line.trim().startsWith("##")).join(" ");
  return /\d|@|https?:\/\/|www\./i.test(body);
}
const POLICY_TOPICS = new Set<KbTopic>(["contact_hours", "pricing_policies", "support_info", "shipping_returns"]);

export interface SkippedTopic {
  topic: KbTopic;
  reason: "empty" | "thin";
}

export function projectDiscoveryTopics(
  discovery: DiscoveryInput,
  profile: ProfileInput,
  ctx: ProjectionContext,
  /** Collects the topics left out and why, for the caller to show as gaps. */
  skipped?: SkippedTopic[],
): ProjectedEntry[] {
  const entries: ProjectedEntry[] = [];
  for (const { topic, build } of TOPIC_BUILDERS) {
    const content = build(discovery, profile, ctx.language);
    // An entry must carry real content, not just a heading. "## Pricing model"
    // with nothing under it (which is what a discovery full of "unknown"
    // sentinels used to produce) is a near-empty chunk that competes with real
    // knowledge during retrieval while teaching the employee nothing.
    if (!hasSubstance(content)) {
      // Contact channels were found but none had anything usable: that is the
      // thin case (retired), not the model having said nothing (kept).
      const hadChannels = topic === "contact_hours" && Array.isArray(obj(discovery.communication).channels) && (obj(discovery.communication).channels as unknown[]).length > 0;
      skipped?.push({ topic, reason: hadChannels ? "thin" : "empty" });
      continue;
    }
    if (POLICY_TOPICS.has(topic) && !hasConcreteFact(content)) {
      skipped?.push({ topic, reason: "thin" });
      continue;
    }
    entries.push(
      buildEntry({
        topic,
        title: titleFor(topic, ctx.language),
        content,
        sourceType: "onboarding_scan",
        sourceUrl: discovery.websiteDomain ? `https://${String(discovery.websiteDomain).replace(/^https?:\/\//, "")}` : undefined,
        language: ctx.language,
        now: ctx.now,
      }),
    );
  }
  return entries;
}

/**
 * Individual crawled pages, kept as their own sources per the spec.
 *
 * 2026-10-14, from the dev store's first rescan:
 *  - The same page reached by two addresses (/faq/ and /pages/faq) is ONE
 *    document: pages are grouped by content checksum, keeping the address the
 *    page names as canonical, else the shortest path, else the first.
 *  - The header and footer every page repeats are removed from each page but
 *    the home page, so a chunk is about its page. Only with at least
 *    BOILERPLATE_MIN_PAGES distinct pages, and never down to nothing.
 *  - A page is titled by its own title (the crawler passes the h1 or <title>).
 */
export const BOILERPLATE_MIN_PAGES = 3;
const MIN_PAGE_CHARS = 40;
const MIN_SHARED_WORDS = 5;

export function projectPages(pages: PageInput[], ctx: ProjectionContext): ProjectedEntry[] {
  const usable = pages.filter((p) => p && p.url && normalizeContentLength(p.content) >= MIN_PAGE_CHARS);

  // One per content: the canonical address wins.
  const groups = new Map<string, PageInput[]>();
  for (const p of usable) {
    const key = checksumOf(normalizeContent(p.content));
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const pathLen = (u: string) => { try { return new URL(u).pathname.length; } catch { return u.length; } };
  const unique = [...groups.values()].map((group) => {
    if (group.length === 1) return group[0]!;
    const canon = group.map((p) => (p.canonical ? normalizeUrl(p.canonical) : null)).find(Boolean);
    const byCanon = canon ? group.find((p) => normalizeUrl(p.url) === canon) : undefined;
    const home = group.find((p) => p.home);
    return home ?? byCanon ?? [...group].sort((a, b) => pathLen(a.url) - pathLen(b.url))[0]!;
  });

  const stripped = stripSharedBoilerplate(unique);
  return unique.map((p, i) =>
    buildEntry({
      topic: "website_pages",
      // The home page's h1 is a campaign line ("The Quiet Season"), not what
      // the page is: it is titled by the site.
      title: p.home ? homeTitle(p, ctx.language) : p.title?.trim() || p.url,
      content: stripped[i]!,
      sourceType: "url",
      sourceUrl: p.url,
      language: ctx.language,
      now: ctx.now,
    }),
  );
}

function homeTitle(p: PageInput, language: string): string {
  if (isHe(language)) return p.siteName?.trim() ? `דף הבית - ${p.siteName.trim()}` : "דף הבית";
  return p.siteName?.trim() || "Home page";
}

/** Each page's content without the word run that opens, and the one that closes, every page. */
function stripSharedBoilerplate(pages: PageInput[]): string[] {
  const contents = pages.map((p) => p.content);
  if (new Set(contents.map((c) => normalizeContent(c))).size < BOILERPLATE_MIN_PAGES) return contents;
  const words = contents.map((c) => c.trim().split(/\s+/));
  const shortest = Math.min(...words.map((w) => w.length));
  let prefix = 0;
  while (prefix < shortest && words.every((w) => w[prefix] === words[0]![prefix])) prefix++;
  let suffix = 0;
  while (suffix < shortest - prefix && words.every((w) => w[w.length - 1 - suffix] === words[0]![words[0]!.length - 1 - suffix])) suffix++;
  if (prefix < MIN_SHARED_WORDS) prefix = 0;
  if (suffix < MIN_SHARED_WORDS) suffix = 0;
  if (!prefix && !suffix) return contents;
  return pages.map((p, i) => {
    if (p.home) return contents[i]!;
    const w = words[i]!;
    const body = w.slice(prefix, w.length - suffix).join(" ").trim();
    // Never strip a page to nothing: what is left must still be a page.
    return body.length >= MIN_PAGE_CHARS ? body : contents[i]!;
  });
}

/**
 * Readiness answers become ONE entry per question rather than a single
 * "answers" blob: each is retrieved independently, and a customer who later
 * corrects one answer should not invalidate the checksum of the other ten.
 */
export function projectReadinessAnswers(
  answers: ReadinessAnswer[],
  ctx: ProjectionContext,
): ProjectedEntry[] {
  return answers
    .filter((a) => a && a.question?.trim() && a.answer?.trim())
    .map((a) => {
      const topic = a.topic ?? "readiness_answers";
      const entry = buildEntry({
        topic,
        title: a.question.trim().slice(0, 200),
        content: `**${a.question.trim()}**\n\n${a.answer.trim()}`,
        sourceType: "readiness_answer",
        language: ctx.language,
        now: ctx.now,
      });
      // One document per question: fold the question into the key so two
      // answers under the same topic cannot overwrite each other.
      entry.metadata.dedupeKey = `readiness_answer:${slug(a.question)}`;
      return entry;
    });
}

/** Uploaded files and Drive documents, keyed on their own stable id. */
export function projectExternalSources(
  sources: ExternalSourceInput[],
  ctx: ProjectionContext,
): ProjectedEntry[] {
  return sources
    .filter((s) => s && s.externalId && s.content?.trim())
    .map((s) =>
      buildEntry({
        topic: s.sourceType === "drive" ? "processes" : "website_pages",
        title: s.title?.trim() || s.externalId,
        content: s.content,
        sourceType: s.sourceType,
        sourceUrl: s.sourceUrl,
        externalId: s.externalId,
        language: ctx.language,
        now: ctx.now,
      }),
    );
}

function normalizeContentLength(raw: string): number {
  return String(raw ?? "").trim().length;
}

/**
 * Does this body say anything once the headings are removed?
 *
 * Measured on the non-heading lines, so a document made entirely of section
 * titles scores zero regardless of how many sections it has.
 *
 * The floor is deliberately low. Stripping the "unknown"/"n/a" sentinels
 * already empties the junk entries, so this only needs to catch a body that
 * says nothing at all - and a business with exactly one short product name
 * still has a real catalogue worth writing down.
 */
function hasSubstance(content: string): boolean {
  if (!content) return false;
  const body = content
    .split("\n")
    .filter((line) => !line.trim().startsWith("##"))
    .join(" ")
    .replace(/^[-*\s]+/gm, "")
    .trim();
  return body.length >= 8;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9֐-׿]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || "question";
}
