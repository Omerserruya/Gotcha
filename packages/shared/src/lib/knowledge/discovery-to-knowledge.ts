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

function str(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function list(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (typeof item === "string") return item.trim();
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
  return language?.toLowerCase().startsWith("he") ? entry.he : entry.en;
}

// ─── Topic bodies ───────────────────────────────────────────

function businessOverview(d: DiscoveryInput, p: ProfileInput): string {
  const b = obj(d.business);
  return join([
    section("Who we are", [
      str(p.organizationName) && `Name: ${str(p.organizationName)}`,
      str(p.industry) || str(b.industry) ? `Industry: ${str(p.industry) || str(b.industry)}` : "",
      str(p.country) && `Country: ${str(p.country)}`,
      str(d.websiteDomain || "") && `Website: ${str(d.websiteDomain || "")}`,
    ].filter(Boolean) as string[]),
    section("What we do", str(b.summary) || str(p.businessDescription)),
    section("Value proposition", str(b.valueProp)),
    section("Business model", str(b.businessModel)),
    section("Who we serve", list(b.personas).length ? list(b.personas) : (str(b.icp) ? [str(b.icp)] : [])),
  ]);
}

function productsServices(d: DiscoveryInput): string {
  const b = obj(d.business);
  return join([
    section("Products", list(b.products)),
    section("Services", list(b.services)),
  ]);
}

function pricingPolicies(d: DiscoveryInput): string {
  const b = obj(d.business);
  const k = obj(obj(d.knowledge).policies);
  return join([
    section("Pricing model", str(b.pricingModel)),
    section("Terms", str(k.terms)),
  ]);
}

function shippingReturns(d: DiscoveryInput): string {
  const k = obj(obj(d.knowledge).policies);
  return join([
    section("Shipping", str(k.shipping)),
    section("Returns", str(k.returns)),
    section("Refunds", str(k.refunds)),
    section("Cancellations", str(k.cancellations)),
  ]);
}

function supportInfo(d: DiscoveryInput): string {
  const k = obj(d.knowledge);
  return join([
    section("Help centre", str(k.helpCenter)),
    section("Documentation", str(k.docs)),
    section("Privacy", str(obj(k.policies).privacy)),
  ]);
}

function contactHours(d: DiscoveryInput): string {
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
  return join([section("How to reach us", lines)]);
}

function faq(d: DiscoveryInput): string {
  const k = obj(d.knowledge);
  const raw = k.faq;
  if (typeof raw === "string") return join([section("Frequently asked questions", str(raw))]);
  if (Array.isArray(raw)) {
    const pairs = raw
      .map((item) => {
        const o = obj(item);
        const q = str(o.question) || str(o.q);
        const a = str(o.answer) || str(o.a);
        return q && a ? `**${q}**\n${a}` : "";
      })
      .filter(Boolean);
    return pairs.length ? `## Frequently asked questions\n\n${pairs.join("\n\n")}` : "";
  }
  return "";
}

function brandVoice(d: DiscoveryInput): string {
  const b = obj(d.brand);
  const forbidden = list(b.forbiddenWords);
  return join([
    section("Voice", str(b.voice)),
    section("Tone", str(b.tone)),
    section("Style", str(b.style)),
    section("Positioning", str(b.positioning)),
    section("Preferred vocabulary", list(b.vocabulary)),
    forbidden.length ? section("Never use these words", forbidden) : "",
    section("Languages", list(b.languages)),
  ]);
}

const TOPIC_BUILDERS: Array<{ topic: KbTopic; build: (d: DiscoveryInput, p: ProfileInput) => string }> = [
  { topic: "business_overview", build: businessOverview },
  { topic: "products_services", build: (d) => productsServices(d) },
  { topic: "support_info", build: (d) => supportInfo(d) },
  { topic: "shipping_returns", build: (d) => shippingReturns(d) },
  { topic: "pricing_policies", build: (d) => pricingPolicies(d) },
  { topic: "contact_hours", build: (d) => contactHours(d) },
  { topic: "faq", build: (d) => faq(d) },
  { topic: "brand_voice", build: (d) => brandVoice(d) },
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
    const content = build(discovery, profile);
    if (!content || content.length < 24) continue;
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

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9֐-׿]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || "question";
}
