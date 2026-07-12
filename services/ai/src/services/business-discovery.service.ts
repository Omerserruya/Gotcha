/**
 * Business Discovery — the Onboarding Intelligence Engine (Bible Part II).
 *
 * The moat. Given the raw text of a company's public pages PLUS the structured
 * signals the caller extracted deterministically (real emails, phones, wa.me
 * numbers, social handles, a strength-scored platform guess, tools), it produces
 * a deep, confidence-levelled understanding of the business and an honest list
 * of what it could NOT confidently determine.
 *
 * TWO doctrines govern this file (Pass II — "Wonder & Confidence"):
 *   1. EVERY finding carries a confidence. Never a naked fact.
 *   2. NEVER assert absence unless we actually looked where it would be. The
 *      deterministically-extracted identifiers are GROUND TRUTH and are injected
 *      authoritatively, so we can never false-negative a channel that exists.
 *
 * Only new LLM call in onboarding, hence services/ai (per CLAUDE.md).
 */

import { generateResponse, getDefaultModel } from "./ai.service";

// ─── Contract ───────────────────────────────────────────────

/** Per-finding confidence. `unknown` == "couldn't confidently determine". */
export type FindingConfidence = "confirmed" | "likely" | "low" | "needs_verification" | "unknown";

/** Rich deterministic signals from the caller's crawl (regex, no LLM). */
export interface DiscoverySignals {
  emails?: string[];
  phones?: string[];
  whatsapp?: string[];
  instagram?: string[];
  facebook?: string[];
  messenger?: string[];
  telegram?: string[];
  tiktok?: string[];
  contactForm?: boolean;
  liveChat?: string | null;
  platform?: { slug: string; name: string; strength: number } | null;
  otherPlatforms?: Array<{ slug: string; name: string; strength: number }>;
  tracking?: string[];
  tools?: string[];
  social?: string[];
  coverage?: string[]; // URLs actually read
  /** email → "gmail" | "outlook" (MX lookup done by the caller). */
  emailProviders?: Record<string, string>;
}

export interface DiscoveryInput {
  tenantId: string;
  domain: string;
  locale?: string;
  pages: Array<{ url: string; text: string }>;
  signals?: DiscoverySignals;
}

export interface DiscoveryGap {
  id: string;
  domain: "brand" | "business" | "knowledge" | "communication" | "technology" | "customers";
  label: string;
  severity: "high" | "medium" | "low";
  ask: string;
  confidence: FindingConfidence; // usually "unknown"/"needs_verification" — an honest gap
}

export interface DiscoveryChannel {
  type: string; // whatsapp | instagram | facebook | messenger | telegram | email | phone | website_chat | contact_form | tiktok
  identifier?: string; // the real handle/number/address
  purpose?: string; // probable purpose ("Customer Support", "Sales", …)
  confidence: FindingConfidence;
  /** Email channels: the detected mail platform ("gmail" | "outlook") from an MX lookup. */
  provider?: string;
}

export interface DiscoveryTech {
  platform: { slug: string; name: string; confidence: FindingConfidence } | null;
  legacy: Array<{ slug: string; name: string }>; // demoted artifacts — never recommended
  tracking: Array<{ slug: string; name: string }>;
  tools: Array<{ slug: string; name: string; category?: string; confidence?: FindingConfidence }>;
}

export interface PolicyFinding { found: boolean | null; confidence: FindingConfidence; url?: string }

export interface DiscoveryRecommendation {
  employeeRole: "customer_support" | "sales" | "reception" | "conversation_intelligence";
  employeeName: string;
  reason: string;
  systems: Array<{ slug: string; reason: string; alreadyDetected?: boolean }>;
  knowledge: Array<{ label: string; reason: string }>;
  channel?: string;
}

export interface DiscoveryReport {
  brand: {
    personality?: string;
    voice?: string;
    tone?: string;
    style?: string;
    audience?: string;
    positioning?: string;
    vocabulary?: string[];
    preferredTerminology?: string[];
    forbiddenWords?: string[];
    ctaStyle?: string;
    /** One on-brand opening line the employee would greet with (customer's language, brand's emoji style). */
    greetingExample?: string;
    languages?: string[];
    confidence?: FindingConfidence;
  };
  business: {
    name?: string; country?: string; industry?: string; icp?: string;
    personas?: string[]; products?: string[]; services?: string[];
    pricingModel?: string; valueProp?: string; businessModel?: string; summary?: string;
    confidence?: FindingConfidence;
  };
  knowledge: {
    hasFaq?: boolean; hasHelpCenter?: boolean; hasDocs?: boolean;
    policies?: { shipping?: PolicyFinding; returns?: PolicyFinding; refunds?: PolicyFinding; terms?: PolicyFinding; privacy?: PolicyFinding };
    articleCountEstimate?: number | null;
    topics?: string[];
  };
  communication: { channels: DiscoveryChannel[] };
  technology: DiscoveryTech;
  gaps: DiscoveryGap[];
  recommendation: DiscoveryRecommendation;
  confidence: { business?: number; brand?: number; knowledge?: number; customers?: number; communication?: number; integrations?: number };
  report: string;
}

const LOCALE_NAMES: Record<string, string> = { en: "English", he: "Hebrew", ar: "Arabic" };
const VALID_CONF = new Set<FindingConfidence>(["confirmed", "likely", "low", "needs_verification", "unknown"]);

function stripFences(s: string): string { return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim(); }
function str(v: unknown): string | undefined { return typeof v === "string" && v.trim() ? v.trim() : undefined; }
function bool(v: unknown): boolean | undefined { return typeof v === "boolean" ? v : undefined; }
function list(v: unknown, cap = 20): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((s) => s.trim()).slice(0, cap) : [];
}
function num0to100(v: unknown): number | undefined {
  if (typeof v !== "number" || Number.isNaN(v)) return undefined;
  return Math.max(0, Math.min(100, Math.round(v)));
}
function conf(v: unknown, fallback: FindingConfidence = "likely"): FindingConfidence {
  return typeof v === "string" && VALID_CONF.has(v as FindingConfidence) ? (v as FindingConfidence) : fallback;
}
function platformConfidence(strength: number): FindingConfidence {
  return strength >= 3 ? "confirmed" : strength === 2 ? "likely" : "low";
}

// ─── The engine ─────────────────────────────────────────────

const SYSTEM_PROMPT = (lang: string) =>
  [
    "You are GOTCHA's Business Intelligence engine. A company is being onboarded onto an AI operating system.",
    "You receive: (a) the text of the company's public pages that were actually crawled, and (b) DETERMINISTIC signals already extracted from the raw HTML (real emails, phone numbers, WhatsApp numbers, social handles, a strength-scored platform detection, tools).",
    "",
    "TWO LAWS, above everything:",
    "1. CONFIDENCE ON EVERY FINDING. Each finding carries a confidence: \"confirmed\" | \"likely\" | \"low\" | \"needs_verification\" | \"unknown\". Be calibrated. Appearing omniscient is worthless; being trustworthy is everything.",
    "2. NEVER STATE ABSENCE UNLESS YOU LOOKED. Only mark a policy/detail as not-found if the crawled pages plausibly COVER it and it is genuinely absent. If you did not read the page where it would live, say \"unknown\" (couldn't confidently determine) — NEVER assert it doesn't exist. A false 'missing' destroys trust. 'I couldn't confidently determine' always beats a false negative.",
    "",
    "GROUND TRUTH: the deterministic signals are FACTS extracted from the HTML. If a WhatsApp number, email, phone, or social handle is provided, that channel EXISTS — treat it as confirmed and never say the business lacks it. Trust the strength-scored platform: the highest-strength one is the ACTIVE platform; a low-strength match is a legacy artifact or tracking script and must NOT be presented as the platform or recommended.",
    "",
    "Depth over breadth. Be SPECIFIC and NON-OBVIOUS (counts, languages, conflicting pages). Generic output ('you are in retail') is a failure. Never invent specifics — an honest gap beats a guess.",
    `Write ALL human-readable prose (summary, reasons, report, gap labels, purposes) in ${lang}. Keep enum-like slugs (employeeRole, confidence values, tool slugs) in English.`,
    "",
    "Respond ONLY with a single JSON object (no prose, no code fences) with EXACTLY these keys:",
    "{",
    '  "brand": { "personality": string, "voice": string, "tone": string, "style": string, "audience": string, "positioning": string, "vocabulary": string[], "preferredTerminology": string[], "forbiddenWords": string[], "ctaStyle": string, "greetingExample": string, "languages": string[], "confidence": conf },',
    '  "business": { "name": string, "country": string, "industry": string, "icp": string, "personas": string[], "products": string[], "services": string[], "pricingModel": string, "valueProp": string, "businessModel": string, "summary": string, "confidence": conf },',
    '  "knowledge": { "hasFaq": boolean, "hasHelpCenter": boolean, "hasDocs": boolean, "policies": { "shipping": {"found": boolean|null, "confidence": conf}, "returns": {...}, "refunds": {...}, "terms": {...}, "privacy": {...} }, "articleCountEstimate": number|null, "topics": string[] },',
    '  "channels": [ { "type": string, "identifier": string, "purpose": string, "confidence": conf } ],',
    '  "recommendation": { "employeeRole": "customer_support"|"sales"|"reception"|"conversation_intelligence", "employeeName": string, "reason": string, "systems": [ { "slug": string, "reason": string } ], "knowledge": [ { "label": string, "reason": string } ], "channel": string },',
    '  "gaps": [ { "id": string, "domain": "brand"|"business"|"knowledge"|"communication"|"technology"|"customers", "label": string, "severity": "high"|"medium"|"low", "ask": string, "confidence": conf } ],',
    '  "domainConfidence": { "business": number, "brand": number, "knowledge": number, "customers": number, "communication": number, "integrations": number },',
    '  "report": string',
    "}",
    "(\"conf\" means one of the five confidence strings.)",
    "",
    "Rules:",
    "- brand: this is one of the biggest assets for an AI employee. Fill personality, tone, voice, style, audience, positioning, preferred terminology and forbidden words richly and specifically — how the business SOUNDS, so the AI can speak AS them.",
    "- brand.greetingExample: ONE short greeting line the AI employee would open a chat with, written in the brand's own voice and language, matching its warmth and emoji style exactly as the site sounds (e.g. a warm feminine Hebrew activewear brand might open \"היי מהממת 🩶 איך אפשר לעזור?\"). Grounded in the real voice — never generic.",
    "- recommendation.employeeName: a REAL human first name that fits the brand's primary language and voice (e.g. \"מאיה\" or \"נועה\" for a warm Hebrew brand, \"Maya\" or \"Daniel\" for English) — never a role title, never \"AI Assistant\".",
    "- channels: add PURPOSE and confidence to each. You may add channels you infer from the page text; the caller merges your list with the confirmed identifiers.",
    "- policies.*.found: true only if you saw it; false only if you read where it'd be and it's absent; null (with confidence \"unknown\") otherwise.",
    "- knowledge.policies confidence: \"confirmed\" when you read the actual policy page; lower otherwise.",
    "- gaps: a gap is a claimed ABSENCE, and it must NEVER contradict your own findings or the deterministic signals. If a WhatsApp number exists, the business HAS a customer phone contact (a WhatsApp number IS a phone number) — never emit a 'no phone / no call center' gap. If shipping/returns/refund policies were found, never claim answers or articles about those topics are missing — acknowledge what exists and only flag what is genuinely absent. Check every gap against every finding before emitting it; a contradicted gap is a critical failure.",
    "- recommendation.systems: prefer systems ALREADY detected (act on what we know) before proposing new ones. slug lowercase.",
    "- domainConfidence.* are 0-100 (how much of that dimension you understand); 'customers' should be low (no CRM yet).",
    "- report: first-person briefing in the customer's language ('I analyzed your business. I found …. I couldn't confidently determine …. My early read is …'). 4-8 short sentences; at least one honest uncertainty.",
    "",
    "KEEP THE JSON COMPACT (never truncate). Caps: products ≤ 18, services ≤ 10, personas ≤ 5, vocabulary ≤ 12, preferredTerminology ≤ 10, forbiddenWords ≤ 10, topics ≤ 10, channels ≤ 10, gaps ≤ 8.",
  ].join("\n");

function signalBlock(s: DiscoverySignals): string {
  const j = (a?: string[]) => (a && a.length ? a.join(", ") : "none");
  const plat = s.platform ? `${s.platform.name} (slug=${s.platform.slug}, strength=${s.platform.strength} → ${s.platform.strength >= 3 ? "ACTIVE" : s.platform.strength === 2 ? "likely active" : "WEAK/legacy — do not recommend"})` : "none detected";
  const others = (s.otherPlatforms || []).map((p) => `${p.name}(strength=${p.strength}, likely legacy/artifact)`).join(", ") || "none";
  return [
    "DETERMINISTIC SIGNALS (ground truth — these EXIST):",
    `- Emails: ${j(s.emails)}`,
    `- Phones: ${j(s.phones)}`,
    `- WhatsApp numbers: ${j(s.whatsapp)}`,
    `- Instagram: ${j(s.instagram)}   Facebook: ${j(s.facebook)}   Messenger: ${j(s.messenger)}   Telegram: ${j(s.telegram)}   TikTok: ${j(s.tiktok)}`,
    `- Contact form present: ${s.contactForm ? "yes" : "unknown"}   Live chat widget: ${s.liveChat || "none"}`,
    `- Active platform: ${plat}`,
    `- Other platform matches (treat as legacy/artifacts): ${others}`,
    `- Tracking scripts: ${j(s.tracking)}`,
    `- Third-party tools/apps: ${j(s.tools)}`,
    `- Pages actually crawled (your coverage — only assert absence within these): ${(s.coverage || []).join(" | ") || "homepage only"}`,
  ].join("\n");
}

export async function discoverBusiness(input: DiscoveryInput): Promise<DiscoveryReport | null> {
  const lang = LOCALE_NAMES[input.locale || "en"] || "English";
  const corpus = input.pages
    .map((p, i) => `# PAGE: ${p.url}\n${(p.text || "").slice(0, i === 0 ? 6000 : 2400)}`)
    .join("\n\n")
    .slice(0, 18000);

  try {
    const resp = await generateResponse({
      tenantId: input.tenantId,
      model: getDefaultModel(),
      temperature: 0.2,
      maxTokens: 4096,
      responseFormat: { type: "json_object" },
      metadata: { type: "onboarding_discovery" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT(lang) },
        { role: "user", content: `Website: ${input.domain}\n\n${signalBlock(input.signals || {})}\n\n--- CRAWLED PAGE TEXT ---\n${corpus}\n\nReturn the business intelligence JSON.` },
      ],
    });

    let parsed: any;
    try { parsed = JSON.parse(stripFences(resp.content ?? "")); }
    catch { console.warn(`[business-discovery] JSON parse failed (len=${(resp.content ?? "").length})`); return null; }
    if (!parsed || typeof parsed !== "object") return null;
    return normalizeReport(parsed, input);
  } catch (err: any) {
    console.warn("[business-discovery] scan failed:", err?.message);
    return null;
  }
}

// Build channels authoritatively from the ground-truth signals, then enrich with
// the LLM's inferred purposes. This is the false-negative fix: a detected
// identifier is ALWAYS surfaced as a confirmed channel.
function buildChannels(raw: any, s: DiscoverySignals): DiscoveryChannel[] {
  const llm = new Map<string, any>();
  for (const c of Array.isArray(raw.channels) ? raw.channels : []) {
    const t = str(c?.type)?.toLowerCase();
    if (t) llm.set(t, c);
  }
  const out: DiscoveryChannel[] = [];
  const add = (type: string, identifier: string | undefined, defPurpose: string) => {
    const l = llm.get(type);
    out.push({ type, identifier, purpose: str(l?.purpose) || defPurpose, confidence: "confirmed" });
  };
  (s.whatsapp || []).forEach((n) => add("whatsapp", n, "Customer Support"));
  (s.instagram || []).forEach((h) => add("instagram", `@${h}`, "Sales / brand"));
  (s.facebook || []).forEach((h) => add("facebook", h, "Brand / community"));
  (s.messenger || []).forEach((h) => add("messenger", h, "Customer Support"));
  (s.telegram || []).forEach((h) => add("telegram", `@${h}`, "Support"));
  (s.tiktok || []).forEach((h) => add("tiktok", `@${h}`, "Brand / marketing"));
  (s.emails || []).forEach((e) => {
    const l = llm.get("email");
    const provider = s.emailProviders?.[e];
    out.push({ type: "email", identifier: e, purpose: str(l?.purpose) || "General inquiries", confidence: "confirmed", ...(provider ? { provider } : {}) });
  });
  (s.phones || []).forEach((p) => add("phone", p, "Phone support"));
  if (s.liveChat) out.push({ type: "website_chat", identifier: s.liveChat, purpose: str(llm.get("website_chat")?.purpose) || "Lead generation", confidence: "confirmed" });
  else if (s.contactForm) out.push({ type: "contact_form", identifier: undefined, purpose: str(llm.get("contact_form")?.purpose) || "General inquiries", confidence: "confirmed" });

  // Add any channel the LLM inferred that we didn't extract (lower confidence)
  // — but ONLY genuine communication channels. The LLM sometimes emits junk
  // types like "website", "platform", "analytics", "seo": those are NOT ways to
  // talk to customers and must never leak into channels (they belong under
  // Technology). Whitelist keeps communication clean.
  const have = new Set(out.map((c) => c.type));
  for (const [type, c] of llm) {
    if (have.has(type) || !VALID_CHANNEL_TYPES.has(type)) continue;
    out.push({ type, identifier: str(c?.identifier), purpose: str(c?.purpose), confidence: conf(c?.confidence, "low") });
  }
  return out.slice(0, 12);
}

// Genuine ways a business talks to customers. Anything the LLM invents outside
// this set (website, platform, analytics, blog, seo, …) is dropped.
const VALID_CHANNEL_TYPES = new Set([
  "whatsapp", "instagram", "facebook", "messenger", "telegram", "tiktok",
  "email", "phone", "sms", "website_chat", "contact_form", "newsletter",
  "popup", "line", "viber", "wechat",
]);

function policy(p: any): PolicyFinding {
  if (typeof p === "boolean") return { found: p, confidence: p ? "likely" : "unknown" };
  if (p && typeof p === "object") {
    const found = typeof p.found === "boolean" ? p.found : null;
    return { found, confidence: conf(p.confidence, found === null ? "unknown" : "likely"), url: str(p.url) };
  }
  return { found: null, confidence: "unknown" };
}

export function normalizeReport(raw: any, input: DiscoveryInput): DiscoveryReport {
  const b = raw.brand || {};
  const biz = raw.business || {};
  const kn = raw.knowledge || {};
  const pol = kn.policies || {};
  const s = input.signals || {};

  // Technology: platform is authoritative from the strength-scored signal.
  const platform = s.platform
    ? { slug: s.platform.slug, name: s.platform.name, confidence: platformConfidence(s.platform.strength) }
    : null;
  const legacy = (s.otherPlatforms || []).map((p) => ({ slug: p.slug, name: p.name }));
  const TOOL_NAMES: Record<string, string> = {
    hubspot: "HubSpot", salesforce: "Salesforce", zendesk: "Zendesk", intercom: "Intercom", crisp: "Crisp",
    tawk: "Tawk.to", gorgias: "Gorgias", tidio: "Tidio", drift: "Drift", zopim: "Zopim", stripe: "Stripe",
    paypal: "PayPal", calendly: "Calendly", klaviyo: "Klaviyo", yotpo: "Yotpo", judgeme: "Judge.me", loox: "Loox", returngo: "ReturnGO",
  };
  const TRACK_NAMES: Record<string, string> = { google_analytics: "Google Analytics", meta_pixel: "Meta Pixel", tiktok_pixel: "TikTok Pixel", hotjar: "Hotjar" };
  const tools = (s.tools || []).map((slug) => ({ slug, name: TOOL_NAMES[slug] || slug, confidence: "confirmed" as FindingConfidence }));
  const tracking = (s.tracking || []).map((slug) => ({ slug, name: TRACK_NAMES[slug] || slug }));

  const rec = raw.recommendation || {};
  const validRoles = new Set(["customer_support", "sales", "reception", "conversation_intelligence"]);
  const employeeRole = validRoles.has(rec.employeeRole) ? rec.employeeRole : "customer_support";
  const detectedSlugs = new Set([platform?.slug, ...tools.map((t) => t.slug)].filter(Boolean));

  // Knowledge is normalized BEFORE gaps so the contradiction filter below can
  // check claimed absences against what was actually found.
  const knowledge: DiscoveryReport["knowledge"] = {
    hasFaq: bool(kn.hasFaq), hasHelpCenter: bool(kn.hasHelpCenter), hasDocs: bool(kn.hasDocs),
    policies: { shipping: policy(pol.shipping), returns: policy(pol.returns), refunds: policy(pol.refunds), terms: policy(pol.terms), privacy: policy(pol.privacy) },
    articleCountEstimate: typeof kn.articleCountEstimate === "number" ? kn.articleCountEstimate : null,
    topics: list(kn.topics, 10),
  };

  const gaps: DiscoveryGap[] = (Array.isArray(raw.gaps) ? raw.gaps : [])
    .map((g: any, i: number) => ({
      id: str(g?.id) || `gap_${i}`,
      domain: ["brand", "business", "knowledge", "communication", "technology", "customers"].includes(g?.domain) ? g.domain : "knowledge",
      label: str(g?.label) || "",
      severity: ["high", "medium", "low"].includes(g?.severity) ? g.severity : "medium",
      ask: str(g?.ask) || "",
      confidence: conf(g?.confidence, "unknown"),
    }))
    .filter((g: DiscoveryGap) => g.label)
    .filter((g: DiscoveryGap) => {
      const rule = contradictedGapRule(g, s, knowledge);
      if (rule) console.log(`[business-discovery] dropped contradicted gap (${rule}): "${g.label}"`);
      return !rule;
    });

  return {
    brand: {
      personality: str(b.personality),
      voice: str(b.voice),
      tone: str(b.tone),
      style: str(b.style),
      audience: str(b.audience),
      positioning: str(b.positioning),
      vocabulary: list(b.vocabulary, 12),
      preferredTerminology: list(b.preferredTerminology, 10),
      forbiddenWords: list(b.forbiddenWords, 10),
      ctaStyle: str(b.ctaStyle),
      greetingExample: str(b.greetingExample),
      languages: list(b.languages, 6),
      confidence: conf(b.confidence, "likely"),
    },
    business: {
      name: str(biz.name), country: str(biz.country), industry: str(biz.industry), icp: str(biz.icp),
      personas: list(biz.personas, 6), products: list(biz.products, 24), services: list(biz.services, 16),
      pricingModel: str(biz.pricingModel), valueProp: str(biz.valueProp), businessModel: str(biz.businessModel), summary: str(biz.summary),
      confidence: conf(biz.confidence, "likely"),
    },
    knowledge,
    communication: { channels: buildChannels(raw, s) },
    technology: { platform, legacy, tracking, tools },
    gaps,
    recommendation: {
      employeeRole,
      employeeName: str(rec.employeeName) || defaultEmployeeName(employeeRole),
      reason: str(rec.reason) || "",
      systems: (Array.isArray(rec.systems) ? rec.systems : [])
        .map((x: any) => ({ slug: str(x?.slug)?.toLowerCase() || "", reason: str(x?.reason) || "", alreadyDetected: detectedSlugs.has(str(x?.slug)?.toLowerCase()) }))
        .filter((x: any) => x.slug),
      knowledge: (Array.isArray(rec.knowledge) ? rec.knowledge : [])
        .map((k: any) => ({ label: str(k?.label) || "", reason: str(k?.reason) || "" }))
        .filter((k: any) => k.label),
      channel: str(rec.channel),
    },
    confidence: {
      business: num0to100(raw.domainConfidence?.business),
      brand: num0to100(raw.domainConfidence?.brand),
      knowledge: num0to100(raw.domainConfidence?.knowledge),
      customers: num0to100(raw.domainConfidence?.customers),
      communication: num0to100(raw.domainConfidence?.communication),
      integrations: num0to100(raw.domainConfidence?.integrations),
    },
    report: str(raw.report) || "",
  };
}

// ─── Gap contradiction filter (Doctrine law 2, enforced in code) ─
//
// A gap is a claimed ABSENCE. The prompt already forbids contradictions, but
// the deterministic signals are ground truth and code has the last word: a gap
// that claims something is missing while the report itself proves it exists is
// dropped here. Bilingual (en/he) because gap prose is written in the
// customer's language. Returns the name of the violated rule, or null.
export function contradictedGapRule(g: DiscoveryGap, s: DiscoverySignals, kn: DiscoveryReport["knowledge"]): string | null {
  // Match against the LABEL only — the label carries the absence claim. The ask
  // is a follow-up question that routinely NAMES adjacent things without
  // claiming they're missing ("…or answer by email?", "is there a FAQ page?"),
  // and matching it drops honest gaps (observed live: an hours/SLA gap killed
  // by 'email', a size-guide gap killed by 'FAQ').
  const text = g.label;
  const p = kn.policies || {};
  const found = (x?: PolicyFinding) => x?.found === true;
  const serviceKnowledgeFound = !!kn.hasFaq || !!kn.hasHelpCenter || found(p.shipping) || found(p.returns) || found(p.refunds);

  // "No customer phone / call center" — but a phone or WhatsApp number was
  // found. A WhatsApp number IS a phone number customers can call/message.
  // NB: bare "מוקד" is NOT matched — it appears inside "ממוקד" (targeted/focused);
  // only the call-center phrasings (מוקד טלפוני / מוקד שירות) count.
  if (/phone|call.?cent|hotline|טלפון|חיוג|מוקד טלפוני|מוקד שירות/i.test(text) && ((s.phones?.length || 0) > 0 || (s.whatsapp?.length || 0) > 0)) {
    return "phone_exists";
  }
  // "No email contact" — but a real email was extracted.
  if (/e-?mail|אימייל|דוא["']?ל|כתובת מייל/i.test(text) && (s.emails?.length || 0) > 0) {
    return "email_exists";
  }
  // "No help center / FAQ / knowledge articles" — but FAQ/help-center or the
  // customer-service policies (shipping/returns/refunds) were actually found.
  if (/help.?cent|faq|knowledge.?base|מרכז עזרה|שאלות נפוצות|מאגר ידע/i.test(text) && serviceKnowledgeFound) {
    return "service_knowledge_exists";
  }
  // "No shipping / returns / refund policy" — but that exact policy was found.
  if (/shipping|delivery|משלוח/i.test(text) && found(p.shipping)) return "shipping_policy_found";
  if (/return|exchange|החזר|החלפ/i.test(text) && (found(p.returns) || found(p.refunds))) return "returns_policy_found";
  if (/refund|זיכוי/i.test(text) && found(p.refunds)) return "refund_policy_found";
  return null;
}

function defaultEmployeeName(role: string): string {
  switch (role) {
    case "sales": return "Sales AI Employee";
    case "reception": return "Reception AI Employee";
    case "conversation_intelligence": return "Conversation Intelligence";
    default: return "Customer Support AI Employee";
  }
}
