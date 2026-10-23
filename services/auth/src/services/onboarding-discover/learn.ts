/**
 * The learn stages of the onboarding scan: extract → write_knowledge →
 * suggest_integrations, run after the pages are read.
 *
 * Each kind (policies, FAQ, profile and contact, brand, products) is
 * extracted, written to the "Website knowledge" base and announced on the
 * feed as soon as it lands - that is what makes the setup screen's "found so
 * far" real. Extraction is in services/ai (new LLM work lives there only);
 * this side picks the pages, writes the documents and keeps the structured
 * result on BusinessDiscovery for /learned and go-live.
 *
 * One kind failing is a warning and the others carry on; only a scan that
 * learned nothing at all fails.
 */
import { prisma, getInternalServiceKey, normalizeDiscoveryTechnology } from "@chatcenter/shared";
import type { LearnContext, ReadPage } from "./pipeline";
import type { ProductsSummary } from "./harvest";

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://ai:4006";

export const WEBSITE_KB_NAME = "Website knowledge";
const WEBSITE_KB_MARKER = "onboarding:website";

export type AiCall = (tenantId: string, method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) => Promise<{ ok: boolean; status: number; body: any }>;

/** The AI service, as the tenant's internal ADMIN (internal key + x-tenant-id). Never throws. */
export const aiInternal: AiCall = async (tenantId, method, path, body) => {
  try {
    const res = await fetch(`${AI_SERVICE_URL}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Internal-Key": getInternalServiceKey(), "x-tenant-id": tenantId },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(120_000),
    });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
  } catch (err: any) {
    return { ok: false, status: 0, body: { error: err?.message ?? "ai_unreachable" } };
  }
};

// ── page selection ───────────────────────────────────────────────────────────

const POLICY_TEXT = /(return|refund|exchange|shipping|delivery|warranty|terms|policy|החזר|החלפ|משלוח|אחריות|תקנון|מדיניות|ביטול)/i;

function pick(pages: ReadPage[], test: (p: ReadPage) => boolean, cap: number): Array<{ url: string; title: string | null; text: string }> {
  return pages.filter(test).slice(0, cap).map((p) => ({ url: p.url, title: p.title, text: p.text }));
}

export function pagesFor(kind: "policies" | "faq" | "profile" | "brand", pages: ReadPage[]) {
  switch (kind) {
    case "policies":
      return pick(pages, (p) => ["policy", "returns", "shipping"].includes(p.kind) || (p.kind !== "product" && POLICY_TEXT.test(p.title ?? "")), 8);
    case "faq":
      return pick(pages, (p) => p.kind === "faq" || p.kind === "help", 4);
    case "profile": {
      const home = pages.slice(0, 1);
      return [...home, ...pages.filter((p) => p.kind === "about" || p.kind === "contact")]
        .slice(0, 4).map((p) => ({ url: p.url, title: p.title, text: p.text }));
    }
    case "brand": {
      const home = pages.slice(0, 1);
      return [...home, ...pages.filter((p) => p.kind === "about"), ...pages.filter((p) => p.kind === "page" || p.kind === "other").slice(1, 3)]
        .slice(0, 4).map((p) => ({ url: p.url, title: p.title, text: p.text }));
    }
  }
}

/** The site's own language, from <html lang> or dir="rtl"; the scan writes in it. */
export function siteLanguage(html: string | undefined, fallback: string): string {
  const m = /<html\b[^>]*\blang=["']?([a-zA-Z]{2})/i.exec(html ?? "");
  if (m) return m[1]!.toLowerCase();
  if (/<html\b[^>]*\bdir=["']?rtl/i.test(html ?? "")) return "he";
  return fallback;
}

// ── knowledge documents ──────────────────────────────────────────────────────

const T: Record<string, Record<string, string>> = {
  he: {
    returns: "מדיניות החזרות", exchange: "מדיניות החלפות", shipping: "משלוחים", refund: "החזר כספי", warranty: "אחריות",
    terms: "תקנון", privacy: "מדיניות פרטיות", other: "מדיניות", faq: "שאלות נפוצות", products: "המוצרים שלנו",
    profile: "על העסק ויצירת קשר", brand: "הקול של המותג", source: "מקור", window: "חלון החזרה (ימים)",
    exchangeAllowed: "החלפה אפשרית", how: "איך", times: "זמני משלוח", costs: "עלויות משלוח", freeOver: "משלוח חינם מעל",
    refundMethod: "אופן ההחזר", refundDays: "ימים להחזר", months: "חודשי אחריות", yes: "כן", no: "לא",
    count: "מספר מוצרים", categories: "קטגוריות", price: "טווח מחירים", examples: "דוגמאות", live: "מידע עדכני על מוצרים והזמנות מגיע מחיבור החנות.",
    hours: "שעות פעילות", address: "כתובת", contact: "יצירת קשר",
  },
  en: {
    returns: "Returns policy", exchange: "Exchange policy", shipping: "Shipping", refund: "Refunds", warranty: "Warranty",
    terms: "Terms", privacy: "Privacy policy", other: "Policy", faq: "Frequently asked questions", products: "Our products",
    profile: "About the business and contact", brand: "Brand voice", source: "Source", window: "Return window (days)",
    exchangeAllowed: "Exchange allowed", how: "How", times: "Shipping times", costs: "Shipping costs", freeOver: "Free shipping over",
    refundMethod: "Refund method", refundDays: "Days to refund", months: "Warranty months", yes: "yes", no: "no",
    count: "Number of products", categories: "Categories", price: "Price range", examples: "Examples", live: "Live product and order details come from the store connection.",
    hours: "Hours", address: "Address", contact: "Contact",
  },
};
const tr = (lang: string) => T[lang === "he" ? "he" : "en"]!;

export interface KnowledgeDoc { key: string; title: string; content: string; sourceUrl: string | null }

export function policyDoc(p: any, lang: string): KnowledgeDoc {
  const t = tr(lang);
  const lines = [p.summary];
  const terms = p.terms ?? {};
  if (terms.windowDays != null) lines.push(`${t.window}: ${terms.windowDays}`);
  if (terms.exchange) {
    if (terms.exchange.allowed != null) lines.push(`${t.exchangeAllowed}: ${terms.exchange.allowed ? t.yes : t.no}`);
    if (terms.exchange.how) lines.push(`${t.how}: ${terms.exchange.how}`);
  }
  if (terms.shipping) {
    if (terms.shipping.times) lines.push(`${t.times}: ${terms.shipping.times}`);
    if (terms.shipping.costs) lines.push(`${t.costs}: ${terms.shipping.costs}`);
    if (terms.shipping.freeOver != null) lines.push(`${t.freeOver}: ${terms.shipping.freeOver}`);
  }
  if (terms.refund) {
    if (terms.refund.method) lines.push(`${t.refundMethod}: ${terms.refund.method}`);
    if (terms.refund.days != null) lines.push(`${t.refundDays}: ${terms.refund.days}`);
  }
  if (terms.warranty?.months != null) lines.push(`${t.months}: ${terms.warranty.months}`);
  if (p.sourceUrl) lines.push(`${t.source}: ${p.sourceUrl}`);
  return { key: `policy:${p.kind}`, title: t[p.kind] ?? t.other!, content: lines.join("\n"), sourceUrl: p.sourceUrl ?? null };
}

export function faqDoc(faq: Array<{ q: string; a: string }>, lang: string): KnowledgeDoc {
  return { key: "faq", title: tr(lang).faq!, content: faq.map((f) => `Q: ${f.q}\nA: ${f.a}`).join("\n\n"), sourceUrl: null };
}

export function productsDoc(p: ProductsSummary, currency: string | null, lang: string): KnowledgeDoc {
  const t = tr(lang);
  const cur = p.priceRange?.currency ?? currency ?? "";
  const lines = [
    `${t.count}: ${p.count}${p.more ? "+" : ""}`,
    p.categories.length ? `${t.categories}: ${p.categories.join(", ")}` : null,
    p.priceRange ? `${t.price}: ${p.priceRange.min}-${p.priceRange.max} ${cur}`.trim() : null,
    p.highlights.length ? `${t.examples}:\n${p.highlights.map((h) => `- ${h.title}${h.price != null ? ` (${h.price} ${cur})`.replace(" )", ")") : ""}`).join("\n")}` : null,
    t.live,
  ].filter(Boolean);
  return { key: "products", title: t.products!, content: lines.join("\n"), sourceUrl: null };
}

export function profileDoc(r: any, lang: string): KnowledgeDoc {
  const t = tr(lang);
  const c = r.contact ?? {};
  const lines = [
    r.profile?.name, r.profile?.summary, r.profile?.valueProp,
    [...(c.emails ?? []), ...(c.phones ?? []), ...(c.whatsapp ?? []).map((w: string) => `WhatsApp ${w}`)].length
      ? `${t.contact}: ${[...(c.emails ?? []), ...(c.phones ?? []), ...(c.whatsapp ?? []).map((w: string) => `WhatsApp ${w}`)].join(", ")}` : null,
    c.address ? `${t.address}: ${c.address}` : null,
    c.hours ? `${t.hours}: ${c.hours}` : null,
  ].filter(Boolean);
  return { key: "profile", title: t.profile!, content: lines.join("\n"), sourceUrl: null };
}

export function brandDoc(b: any, lang: string): KnowledgeDoc {
  const fields = ["personality", "voice", "tone", "style", "audience", "positioning", "ctaStyle", "greetingExample"]
    .map((k) => (b[k] ? `${k}: ${b[k]}` : null));
  const lists = ["vocabulary", "preferredTerminology", "forbiddenWords", "languages"]
    .map((k) => (Array.isArray(b[k]) && b[k].length ? `${k}: ${b[k].join(", ")}` : null));
  return { key: "brand", title: tr(lang).brand!, content: [...fields, ...lists].filter(Boolean).join("\n"), sourceUrl: null };
}

/** The tenant's "Website knowledge" base (scope all: every employee reads it), created once. */
export async function ensureWebsiteKb(tenantId: string): Promise<string> {
  const existing = await prisma.knowledgeBase.findFirst({
    where: { tenantId, description: WEBSITE_KB_MARKER },
    select: { id: true },
  });
  if (existing) return existing.id;
  const kb = await prisma.knowledgeBase.create({
    data: { tenantId, name: WEBSITE_KB_NAME, description: WEBSITE_KB_MARKER, scope: "all" },
    select: { id: true },
  });
  return kb.id;
}

/**
 * Create or replace one document by its dedupe key, through the AI service so
 * it is embedded. A rescan rewrites in place; it never stacks a second copy
 * the employee could quote instead of the current one.
 */
export async function writeDoc(tenantId: string, kbId: string, doc: KnowledgeDoc, ai: AiCall = aiInternal): Promise<string | null> {
  const metadata = { dedupeKey: doc.key, source: "onboarding_scan" };
  const existing = await prisma.knowledgeDocument.findFirst({
    where: { tenantId, knowledgeBaseId: kbId, metadata: { path: ["dedupeKey"], equals: doc.key } },
    select: { id: true },
  });
  const body = { title: doc.title, content: doc.content, metadata, ...(doc.sourceUrl ? { sourceUrl: doc.sourceUrl } : {}) };
  const r = existing
    ? await ai(tenantId, "PUT", `/api/knowledge-bases/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(existing.id)}`, body)
    : await ai(tenantId, "POST", `/api/knowledge-bases/${encodeURIComponent(kbId)}/documents`, { ...body, sourceType: "text" });
  if (!r.ok) return null;
  return (r.body?.data?.id as string | undefined) ?? existing?.id ?? null;
}

// ── discovery row ────────────────────────────────────────────────────────────

/** Merge one kind's structured result into the discovery row's JSON columns. */
async function mergeDiscovery(tenantId: string, change: (row: Record<string, any>) => Record<string, any>): Promise<void> {
  const row = await prisma.businessDiscovery.findUnique({
    where: { tenantId },
    select: { brand: true, business: true, knowledge: true, communication: true, technology: true, recommendation: true },
  });
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});
  const current = {
    brand: obj(row?.brand), business: obj(row?.business), knowledge: obj(row?.knowledge),
    communication: obj(row?.communication), technology: obj(row?.technology), recommendation: obj(row?.recommendation),
  };
  await prisma.businessDiscovery.update({ where: { tenantId }, data: change(current) as any });
}

// ── the stages ───────────────────────────────────────────────────────────────

export interface LearnDeps { ai?: AiCall }

/** Pick the learn stages' dependencies (tests inject the AI service). */
export function learnStages(deps: LearnDeps = {}) {
  const ai = deps.ai ?? aiInternal;

  return async function learn(ctx: LearnContext): Promise<void> {
    const { tenantId, pages, harvest, emit } = ctx;
    const lang = siteLanguage(pages[0]?.html, ctx.locale);
    let learned = 0;
    let kbId: string | null = null;
    let documents = 0;

    const kb = async () => (kbId ??= await ensureWebsiteKb(tenantId));
    const write = async (doc: KnowledgeDoc) => {
      if (!doc.content.trim()) return;
      const id = await writeDoc(tenantId, await kb(), doc, ai);
      if (id) {
        documents++;
        await emit("write_knowledge", "found", "knowledge.written", { key: doc.key, title: doc.title }, { counts: { documents } });
      } else {
        await emit("write_knowledge", "warn", "knowledge.write_failed", { key: doc.key });
      }
    };
    const extract = async (kind: "policies" | "faq" | "profile" | "brand") => {
      const input = pagesFor(kind, pages);
      if (!input.length) {
        await emit("extract", "progress", "extract.none", { kind });
        return null;
      }
      await emit("extract", "progress", "extract.reading", { kind, pages: input.length });
      const r = await ai(tenantId, "POST", "/api/ai-assist/onboarding-extract", { kind, locale: lang, pages: input });
      if (!r.ok) {
        await emit("extract", "warn", "extract.failed", { kind, status: r.status });
        return null;
      }
      if (!r.body?.data?.ok) {
        await emit("extract", "warn", "extract.empty", { kind });
        return null;
      }
      return r.body.data.result;
    };

    // ── products: exact from the platform feed, or "sampled" from product pages ──
    if (harvest.products) {
      await write(productsDoc(harvest.products, null, lang));
      await mergeDiscovery(tenantId, (d) => ({ business: { ...d.business, productsSummary: harvest.products } }));
      learned++;
    } else {
      const sampled = pages.filter((p) => p.kind === "product").length;
      // Never a catalogue size: these are the few pages we read.
      if (sampled) await emit("extract", "found", "products.sampled", { count: sampled }, { found: { productsSampled: sampled } });
    }

    // ── policies ──
    const pol = await extract("policies");
    if (pol?.policies?.length) {
      learned++;
      for (const p of pol.policies) {
        await emit("extract", "found", "policy.found", { kind: p.kind }, { found: { policies: [p.kind] }, counts: { policies: pol.policies.length } });
        await write(policyDoc(p, lang));
      }
      await mergeDiscovery(tenantId, (d) => {
        const flags: Record<string, boolean> = { ...(d.knowledge.policies ?? {}) };
        for (const p of pol.policies) flags[p.kind === "exchange" || p.kind === "refund" ? "returns" : p.kind] = true;
        return { knowledge: { ...d.knowledge, policies: flags, structured: { ...(d.knowledge.structured ?? {}), policies: pol.policies } } };
      });
    }

    // ── FAQ ──
    const faq = await extract("faq");
    if (faq?.faq?.length) {
      learned++;
      await emit("extract", "found", "faq.found", { count: faq.faq.length }, { found: { faqCount: faq.faq.length }, counts: { faqs: faq.faq.length } });
      await write(faqDoc(faq.faq, lang));
      await mergeDiscovery(tenantId, (d) => ({ knowledge: { ...d.knowledge, structured: { ...(d.knowledge.structured ?? {}), faq: faq.faq } } }));
    }

    // ── profile and contact ──
    const prof = await extract("profile");
    if (prof?.profile) {
      learned++;
      const hasContact = (prof.contact?.emails?.length ?? 0) + (prof.contact?.phones?.length ?? 0) + (prof.contact?.whatsapp?.length ?? 0) > 0;
      await emit("extract", "found", "profile.found", { hours: !!prof.contact?.hours, contact: hasContact }, {
        found: { contact: hasContact, hours: !!prof.contact?.hours },
      });
      await write(profileDoc(prof, lang));
      await mergeDiscovery(tenantId, (d) => ({
        business: { ...d.business, ...Object.fromEntries(Object.entries(prof.profile).filter(([, v]) => v != null)) },
        communication: { ...d.communication, contact: prof.contact },
      }));
      if (harvest.products && !harvest.products.priceRange?.currency && prof.currency) {
        // The Shopify feed carries no currency; the page's prices do.
        await write(productsDoc(harvest.products, prof.currency, lang));
      }
    }

    // ── brand ──
    const brand = await extract("brand");
    if (brand?.brand) {
      learned++;
      await emit("extract", "found", "brand.found", undefined, { found: { brand: true } });
      await write(brandDoc(brand.brand, lang));
      await mergeDiscovery(tenantId, (d) => ({
        brand: { ...d.brand, ...brand.brand },
        recommendation: { ...d.recommendation, ...(brand.employeeName ? { employeeName: brand.employeeName } : {}) },
      }));
    }

    // ── technology + the row's lifecycle, so legacy readers see a finished scan ──
    await mergeDiscovery(tenantId, (d) => ({
      // The language the documents were written in; an edit writes in it too.
      knowledge: { ...d.knowledge, structured: { ...(d.knowledge.structured ?? {}), lang } },
      technology: normalizeDiscoveryTechnology({
        ...d.technology,
        platform: harvest.platform ? { slug: harvest.platform, name: harvest.platform === "shopify" ? "Shopify" : "WooCommerce" } : d.technology.platform,
        tools: (ctx.toolsSeen ?? ctx.tools.map((slug) => ({ slug, evidenceUrl: null }))).map((t) => ({ slug: t.slug, name: t.slug, evidenceUrl: t.evidenceUrl })),
      }),
      status: "COMPLETE",
      scanPhase: "done",
      scannedAt: new Date(),
    }));

    if (learned === 0 && pages.length > 0) {
      throw Object.assign(new Error("nothing could be learned from the pages read"), { code: "nothing_learned" });
    }

    // ── integrations to suggest ──
    const suggestions = await integrationSuggestions(tenantId);
    await emit("suggest_integrations", "found", "integrations.suggested", { count: suggestions.length, slugs: suggestions.map((s) => s.slug).join(",") });
  };
}

// ── suggestions ──────────────────────────────────────────────────────────────

export interface IntegrationSuggestion {
  slug: string;
  name: string;
  reason: "platform" | "detected_on_site";
  /** The page that loads the tool ("we saw ReturnGO on ..."), when known. */
  evidenceUrl?: string;
  connect: { kind: "oauth" | "key" };
  connected: boolean;
}

/**
 * Only what this business evidently uses: its store platform first, then
 * tools its pages actually load that exist in the catalogue. Never the whole
 * catalogue.
 */
export async function integrationSuggestions(tenantId: string): Promise<IntegrationSuggestion[]> {
  const disc = await prisma.businessDiscovery.findUnique({ where: { tenantId }, select: { technology: true } });
  const tech = normalizeDiscoveryTechnology(disc?.technology);
  const platform = tech.platform?.slug ?? null;
  const tools = (tech.tools ?? []).map((t: any) => t.slug).filter(Boolean) as string[];
  const evidence = new Map<string, string>(
    ((disc?.technology as any)?.tools ?? []).filter((t: any) => t?.slug && t?.evidenceUrl).map((t: any) => [t.slug, t.evidenceUrl]),
  );
  const wanted = [...(platform ? [platform] : []), ...tools.filter((t) => t !== platform)];
  if (!wanted.length) return [];

  const [catalog, connected] = await Promise.all([
    prisma.integrationCatalog.findMany({ where: { slug: { in: wanted } }, select: { id: true, slug: true, name: true, authType: true } }),
    prisma.tenantIntegration.findMany({ where: { tenantId, status: "CONNECTED" }, select: { integrationId: true } }),
  ]);
  const connectedIds = new Set(connected.map((c) => c.integrationId));
  const bySlug = new Map(catalog.map((c) => [c.slug, c]));
  return wanted
    .map((slug) => bySlug.get(slug))
    .filter((c): c is NonNullable<typeof c> => !!c)
    .map((c) => ({
      slug: c.slug,
      name: c.name,
      reason: c.slug === platform ? ("platform" as const) : ("detected_on_site" as const),
      ...(c.slug !== platform && evidence.get(c.slug) ? { evidenceUrl: evidence.get(c.slug)! } : {}),
      connect: { kind: String(c.authType).startsWith("OAUTH") ? ("oauth" as const) : ("key" as const) },
      connected: connectedIds.has(c.id),
    }));
}
