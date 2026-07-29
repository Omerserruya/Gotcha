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
  title?: string;
  content: string;
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
      if (!type && !detail) return "";
      return [type, detail, purpose && `(${purpose})`].filter(Boolean).join(" - ");
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
export function projectDiscoveryTopics(
  discovery: DiscoveryInput,
  profile: ProfileInput,
  ctx: ProjectionContext,
): ProjectedEntry[] {
  const entries: ProjectedEntry[] = [];
  for (const { topic, build } of TOPIC_BUILDERS) {
    const content = build(discovery, profile, ctx.language);
    // An entry must carry real content, not just a heading. "## Pricing model"
    // with nothing under it (which is what a discovery full of "unknown"
    // sentinels used to produce) is a near-empty chunk that competes with real
    // knowledge during retrieval while teaching the employee nothing.
    if (!hasSubstance(content)) continue;
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

/** Individual crawled pages, kept as their own sources per the spec. */
export function projectPages(pages: PageInput[], ctx: ProjectionContext): ProjectedEntry[] {
  return pages
    .filter((p) => p && p.url && normalizeContentLength(p.content) >= 40)
    .map((p) =>
      buildEntry({
        topic: "website_pages",
        title: p.title?.trim() || p.url,
        content: p.content,
        sourceType: "url",
        sourceUrl: p.url,
        language: ctx.language,
        now: ctx.now,
      }),
    );
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
