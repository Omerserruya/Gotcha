/**
 * Onboarding v2: structured facts from the pages the scan read (2026-10-23).
 *
 * The legacy discovery asked one big prompt for everything and kept policies
 * as found / not-found flags. An AI employee cannot answer "can I return this
 * after 20 days?" from a flag, so this extracts the TERMS - the window in
 * days, whether exchanges are allowed and how, shipping times and costs - and
 * FAQ as question/answer pairs, one small call per kind.
 *
 * The rule every prompt states and every normaliser enforces: only what the
 * page says. A field the page does not state is null, never a typical value.
 * The source URL travels with each item so the owner can check it.
 *
 * All calls go through generateResponse, so usage is logged and metered like
 * every other AI call.
 */
import { generateResponse, getDefaultModel } from "./ai.service";
import { withoutWideDashes } from "../lib/wide-dash";

export type ExtractKind = "policies" | "faq" | "profile" | "brand";

export interface ExtractPage { url: string; title?: string | null; text: string }

export const POLICY_KINDS = ["returns", "exchange", "shipping", "refund", "warranty", "terms", "privacy", "other"] as const;
export type PolicyKind = (typeof POLICY_KINDS)[number];

export interface PolicyTerms {
  windowDays: number | null;
  exchange: { allowed: boolean | null; how: string | null } | null;
  shipping: { times: string | null; costs: string | null; freeOver: number | null } | null;
  refund: { method: string | null; days: number | null } | null;
  warranty: { months: number | null } | null;
}
export interface ExtractedPolicy { kind: PolicyKind; summary: string; terms: PolicyTerms; sourceUrl: string | null }
export interface ExtractedFaq { q: string; a: string; sourceUrl: string | null }
export interface ExtractedProfile {
  profile: { name: string | null; industry: string | null; summary: string | null; valueProp: string | null };
  contact: { emails: string[]; phones: string[]; whatsapp: string[]; address: string | null; hours: string | null };
  currency: string | null;
}
export interface ExtractedBrand {
  brand: {
    personality: string | null; voice: string | null; tone: string | null; style: string | null;
    audience: string | null; positioning: string | null; vocabulary: string[]; preferredTerminology: string[];
    forbiddenWords: string[]; ctaStyle: string | null; greetingExample: string | null; languages: string[];
  };
  employeeName: string | null;
}
export type ExtractResult =
  | { kind: "policies"; policies: ExtractedPolicy[] }
  | { kind: "faq"; faq: ExtractedFaq[] }
  | { kind: "profile" } & ExtractedProfile
  | { kind: "brand" } & ExtractedBrand;

const LANG: Record<string, string> = { en: "English", he: "Hebrew", ar: "Arabic" };
const PER_PAGE = 6000;
const TOTAL = 24000;

const COMMON = (lang: string) => [
  "You read a business's own web pages and return JSON only.",
  "STRICT: state only what the pages say. When a page does not state a value, use null (or an empty list). Never fill a typical or likely value.",
  `Write free-text fields in ${lang}, the language the business's customers read. Keep the business's own terms.`,
  // Spelled by code point so this file itself carries no wide dash.
  `Never use the characters ${String.fromCharCode(0x2014)} or ${String.fromCharCode(0x2013)}. Use a plain hyphen or a comma.`,
  "Every item carries sourceUrl: the URL of the page it came from, exactly as given.",
].join("\n");

const PROMPTS: Record<ExtractKind, string> = {
  policies: [
    "Extract the store's customer policies as TERMS a support agent can apply.",
    `Return {"policies":[{"kind": one of ${POLICY_KINDS.map((k) => `"${k}"`).join("|")}, "summary": string (2-4 sentences, the rules a customer needs), "terms": {"windowDays": number|null, "exchange": {"allowed": boolean|null, "how": string|null}|null, "shipping": {"times": string|null, "costs": string|null, "freeOver": number|null}|null, "refund": {"method": string|null, "days": number|null}|null, "warranty": {"months": number|null}|null}, "sourceUrl": string}]}`,
    "One entry per distinct policy. windowDays is the number of days a customer has to return or cancel. freeOver is the order total above which shipping is free. Omit a policy the pages do not have.",
  ].join("\n"),
  faq: [
    "Extract the frequently asked questions and their answers as the pages state them.",
    'Return {"faq":[{"q": string, "a": string, "sourceUrl": string}]}. At most 40. Keep answers close to the page wording; do not merge or invent questions.',
  ].join("\n"),
  profile: [
    "Extract who the business is and how to reach it.",
    'Return {"profile": {"name": string|null, "industry": string|null, "summary": string|null (2 sentences), "valueProp": string|null}, "contact": {"emails": string[], "phones": string[], "whatsapp": string[], "address": string|null, "hours": string|null (opening or service hours as written)}, "currency": string|null (ISO code of the prices shown, e.g. "ILS")}',
  ].join("\n"),
  brand: [
    "Describe how this business SOUNDS, so an AI employee can speak as it.",
    'Return {"brand": {"personality": string|null, "voice": string|null, "tone": string|null, "style": string|null, "audience": string|null, "positioning": string|null, "vocabulary": string[] (<=12), "preferredTerminology": string[] (<=10), "forbiddenWords": string[] (<=10), "ctaStyle": string|null, "greetingExample": string|null (ONE short opening line in the brand\'s own voice, language and emoji style), "languages": string[]}, "employeeName": string|null (a real first name that fits the brand\'s language and voice, never a role title)}',
  ].join("\n"),
};

function corpus(pages: ExtractPage[]): string {
  return pages
    .map((p) => `# PAGE: ${p.url}${p.title ? ` (${withoutControlChars(p.title)})` : ""}\n${withoutControlChars(p.text || "").slice(0, PER_PAGE)}`)
    .join("\n\n")
    .slice(0, TOTAL);
}

/**
 * Control characters out (tab and newline stay). A page can carry a NUL, the
 * model echoes it, and Postgres refuses it in text and JSON alike - found on
 * dev, where one NUL in an FAQ answer failed the whole scan at write_knowledge.
 */
export function withoutControlChars(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function stripFences(s: string): string { return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim(); }
const str = (v: unknown, cap = 2000): string | null => {
  const t = typeof v === "string" ? withoutControlChars(v).trim() : "";
  return t ? t.slice(0, cap) : null;
};
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const boolOrNull = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const list = (v: unknown, cap: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((s) => withoutControlChars(s).trim()).filter(Boolean).slice(0, cap) : [];

/** A source URL is kept only when it is one of the pages we gave the model. */
function source(v: unknown, pages: ExtractPage[]): string | null {
  const s = str(v, 2048);
  return s && pages.some((p) => p.url === s) ? s : null;
}

export function normalisePolicies(raw: any, pages: ExtractPage[]): ExtractedPolicy[] {
  const items = Array.isArray(raw?.policies) ? raw.policies : [];
  const out: ExtractedPolicy[] = [];
  for (const p of items.slice(0, 12)) {
    const kind = (POLICY_KINDS as readonly string[]).includes(p?.kind) ? (p.kind as PolicyKind) : "other";
    const summary = str(p?.summary, 1500);
    if (!summary) continue;
    const t = p?.terms ?? {};
    out.push({
      kind,
      summary,
      sourceUrl: source(p?.sourceUrl, pages),
      terms: {
        windowDays: num(t.windowDays),
        exchange: t.exchange && typeof t.exchange === "object" ? { allowed: boolOrNull(t.exchange.allowed), how: str(t.exchange.how, 500) } : null,
        shipping: t.shipping && typeof t.shipping === "object"
          ? { times: str(t.shipping.times, 300), costs: str(t.shipping.costs, 300), freeOver: num(t.shipping.freeOver) }
          : null,
        refund: t.refund && typeof t.refund === "object" ? { method: str(t.refund.method, 300), days: num(t.refund.days) } : null,
        warranty: t.warranty && typeof t.warranty === "object" ? { months: num(t.warranty.months) } : null,
      },
    });
  }
  return out;
}

export function normaliseFaq(raw: any, pages: ExtractPage[]): ExtractedFaq[] {
  const items = Array.isArray(raw?.faq) ? raw.faq : [];
  const seen = new Set<string>();
  const out: ExtractedFaq[] = [];
  for (const f of items) {
    const q = str(f?.q, 500);
    const a = str(f?.a, 3000);
    if (!q || !a || seen.has(q.toLowerCase())) continue;
    seen.add(q.toLowerCase());
    out.push({ q, a, sourceUrl: source(f?.sourceUrl, pages) });
    if (out.length >= 40) break;
  }
  return out;
}

export function normaliseProfile(raw: any): ExtractedProfile {
  const p = raw?.profile ?? {};
  const c = raw?.contact ?? {};
  const cur = str(raw?.currency, 3);
  return {
    profile: { name: str(p.name, 200), industry: str(p.industry, 200), summary: str(p.summary, 1000), valueProp: str(p.valueProp, 500) },
    contact: {
      emails: list(c.emails, 10), phones: list(c.phones, 10), whatsapp: list(c.whatsapp, 10),
      address: str(c.address, 500), hours: str(c.hours, 500),
    },
    currency: cur && /^[A-Z]{3}$/.test(cur) ? cur : null,
  };
}

export function normaliseBrand(raw: any): ExtractedBrand {
  const b = raw?.brand ?? {};
  return {
    brand: {
      personality: str(b.personality, 500), voice: str(b.voice, 500), tone: str(b.tone, 300), style: str(b.style, 300),
      audience: str(b.audience, 500), positioning: str(b.positioning, 500),
      vocabulary: list(b.vocabulary, 12), preferredTerminology: list(b.preferredTerminology, 10),
      forbiddenWords: list(b.forbiddenWords, 10), ctaStyle: str(b.ctaStyle, 300),
      greetingExample: str(b.greetingExample, 300), languages: list(b.languages, 5),
    },
    employeeName: str(raw?.employeeName, 40),
  };
}

export async function extractOnboarding(input: {
  tenantId: string;
  kind: ExtractKind;
  locale?: string;
  pages: ExtractPage[];
}): Promise<ExtractResult | null> {
  const pages = input.pages.filter((p) => p && typeof p.url === "string" && typeof p.text === "string" && p.text.trim()).slice(0, 10);
  if (!pages.length) return null;
  const lang = LANG[input.locale || "en"] || "English";
  const resp = await generateResponse({
    tenantId: input.tenantId,
    model: getDefaultModel(),
    temperature: 0.1,
    maxTokens: input.kind === "faq" ? 4096 : 2048,
    responseFormat: { type: "json_object" },
    metadata: { type: `onboarding_extract_${input.kind}` },
    messages: [
      { role: "system", content: `${COMMON(lang)}\n\n${PROMPTS[input.kind]}` },
      { role: "user", content: `--- PAGES ---\n${corpus(pages)}\n\nReturn the JSON.` },
    ],
  });
  let parsed: any;
  try { parsed = JSON.parse(stripFences(resp.content ?? "")); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;

  const result: ExtractResult =
    input.kind === "policies" ? { kind: "policies", policies: normalisePolicies(parsed, pages) }
    : input.kind === "faq" ? { kind: "faq", faq: normaliseFaq(parsed, pages) }
    : input.kind === "profile" ? { kind: "profile", ...normaliseProfile(parsed) }
    : { kind: "brand", ...normaliseBrand(parsed) };
  return withoutWideDashes(result);
}
