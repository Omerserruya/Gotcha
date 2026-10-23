/**
 * What the scan learned, as the review step shows it, and the owner's edits.
 *
 * Read from the discovery row the learn stages wrote. Every edit rewrites the
 * matching knowledge document in the same call, so the AI answers from the
 * corrected text at once - an edit that only changed the screen would leave
 * the employee quoting what the owner just fixed.
 */
import crypto from "crypto";
import { prisma, normalizeDiscoveryTechnology } from "@chatcenter/shared";
import {
  type AiCall,
  type AiFileCall,
  aiInternal,
  aiInternalFile,
  brandDoc,
  ensureWebsiteKb,
  faqDoc,
  policyDoc,
  profileDoc,
  writeDoc,
} from "./learn";

const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});
export const faqId = (q: string) => crypto.createHash("sha1").update(q.trim().toLowerCase()).digest("hex").slice(0, 12);

/** The policy kinds the extraction knows (services/ai onboarding-extract POLICY_KINDS). */
export const POLICY_KINDS = ["returns", "exchange", "shipping", "refund", "warranty", "terms", "privacy", "other"] as const;
const NO_TERMS = { windowDays: null, exchange: null, shipping: null, refund: null, warranty: null };
/** What the owner pastes, as the extraction reads it: 4 pages of 6,000 characters. */
const PAGE_CHARS = 6000;
const MAX_PAGES = 4;
export const PASTE_MAX = 20000;

export const BRAND_FIELDS = [
  "personality", "voice", "tone", "style", "audience", "positioning",
  "vocabulary", "preferredTerminology", "forbiddenWords", "ctaStyle", "greetingExample", "languages",
] as const;

export async function readLearned(tenantId: string) {
  const d = await prisma.businessDiscovery.findUnique({
    where: { tenantId },
    select: { business: true, brand: true, knowledge: true, communication: true, technology: true, websiteDomain: true, status: true },
  });
  if (!d) return null;
  const business = obj(d.business);
  const knowledge = obj(d.knowledge);
  const structured = obj(knowledge.structured);
  const contact = obj(obj(d.communication).contact);
  const tech = normalizeDiscoveryTechnology(d.technology);
  const brand = obj(d.brand);
  const products = business.productsSummary ?? null;
  return {
    domain: d.websiteDomain,
    status: d.status,
    profile: { name: business.name ?? null, industry: business.industry ?? null, summary: business.summary ?? null, valueProp: business.valueProp ?? null },
    products: products
      ? {
          count: products.count, more: !!products.more, categories: products.categories ?? [],
          priceRange: products.priceRange ?? null, highlights: products.highlights ?? [], source: products.source,
        }
      : null,
    policies: (Array.isArray(structured.policies) ? structured.policies : []).map((p: any) => ({ id: p.kind, ...p })),
    faq: (Array.isArray(structured.faq) ? structured.faq : []).map((f: any) => ({ id: faqId(f.q), ...f })),
    contact: {
      emails: contact.emails ?? [], phones: contact.phones ?? [], whatsapp: contact.whatsapp ?? [],
      address: contact.address ?? null, hours: contact.hours ?? null,
    },
    brand: Object.fromEntries(BRAND_FIELDS.map((k) => [k, brand[k] ?? (["vocabulary", "preferredTerminology", "forbiddenWords", "languages"].includes(k) ? [] : null)])),
    platform: tech.platform?.slug ?? null,
    tools: (tech.tools ?? []).map((t: any) => ({ slug: t.slug, name: t.name })),
  };
}

export class LearnedEditRefused extends Error {
  constructor(readonly code: string) { super(code); this.name = "LearnedEditRefused"; }
}

export interface LearnedEdit {
  section: "policies" | "faq" | "profile" | "contact" | "brand";
  id?: string;
  value?: any;
  remove?: boolean;
}

/** Apply one edit to the row and rewrite its knowledge document. Returns the new /learned view. */
export async function editLearned(tenantId: string, edit: LearnedEdit, ai: AiCall = aiInternal) {
  const d = await prisma.businessDiscovery.findUnique({
    where: { tenantId },
    select: { business: true, brand: true, knowledge: true, communication: true, websiteDomain: true },
  });
  if (!d) throw new LearnedEditRefused("NOT_LEARNED");
  const knowledge = obj(d.knowledge);
  const structured = obj(knowledge.structured);
  const lang = await scanLanguage(tenantId);
  const kbId = await ensureWebsiteKb(tenantId);

  switch (edit.section) {
    case "policies": {
      const list: any[] = Array.isArray(structured.policies) ? [...structured.policies] : [];
      const i = list.findIndex((p) => p.kind === edit.id);
      if (i < 0 && !edit.remove && edit.value && "text" in obj(edit.value)) {
        // A policy the scan could not read, pasted by the owner.
        const created = await pastedPolicy(tenantId, edit.id, obj(edit.value).text, lang, ai);
        list.push(created);
        await writeDoc(tenantId, kbId, policyDoc(created, lang), ai);
        await prisma.businessDiscovery.update({
          where: { tenantId },
          data: { knowledge: { ...knowledge, policies: policyFlags(knowledge.policies, [created]), structured: { ...structured, policies: list } } as any },
        });
        break;
      }
      if (i < 0) throw new LearnedEditRefused("NOT_FOUND");
      if (edit.remove) {
        list.splice(i, 1);
        await removeDoc(tenantId, kbId, `policy:${edit.id}`, ai);
      } else {
        const v = obj(edit.value);
        list[i] = { ...list[i], ...(typeof v.summary === "string" ? { summary: v.summary.trim() } : {}), ...(v.terms ? { terms: { ...list[i].terms, ...obj(v.terms) } } : {}) };
        await writeDoc(tenantId, kbId, policyDoc(list[i], lang), ai);
      }
      await prisma.businessDiscovery.update({ where: { tenantId }, data: { knowledge: { ...knowledge, structured: { ...structured, policies: list } } as any } });
      break;
    }
    case "faq": {
      const list: any[] = Array.isArray(structured.faq) ? [...structured.faq] : [];
      const i = list.findIndex((f) => faqId(f.q) === edit.id);
      if (edit.remove) {
        if (i < 0) throw new LearnedEditRefused("NOT_FOUND");
        list.splice(i, 1);
      } else {
        const v = obj(edit.value);
        const q = typeof v.q === "string" ? v.q.trim() : "";
        const a = typeof v.a === "string" ? v.a.trim() : "";
        if (i < 0) {
          // No id: a question the owner adds by hand.
          if (edit.id || !q || !a) throw new LearnedEditRefused(edit.id ? "NOT_FOUND" : "Q_AND_A_REQUIRED");
          list.push({ q, a, sourceUrl: null });
        } else {
          list[i] = { ...list[i], ...(q ? { q } : {}), ...(a ? { a } : {}) };
        }
      }
      if (list.length) await writeDoc(tenantId, kbId, faqDoc(list, lang), ai);
      else await removeDoc(tenantId, kbId, "faq", ai);
      await prisma.businessDiscovery.update({ where: { tenantId }, data: { knowledge: { ...knowledge, structured: { ...structured, faq: list } } as any } });
      break;
    }
    case "profile":
    case "contact": {
      const business = obj(d.business);
      const communication = obj(d.communication);
      const v = obj(edit.value);
      const nextBusiness = edit.section === "profile"
        ? { ...business, ...pickStrings(v, ["name", "industry", "summary", "valueProp"]) }
        : business;
      const contact = edit.section === "contact"
        ? { ...obj(communication.contact), ...pickStrings(v, ["address", "hours"]), ...pickLists(v, ["emails", "phones", "whatsapp"]) }
        : obj(communication.contact);
      await writeDoc(tenantId, kbId, profileDoc({ profile: nextBusiness, contact }, lang), ai);
      await prisma.businessDiscovery.update({
        where: { tenantId },
        data: { business: nextBusiness as any, communication: { ...communication, contact } as any },
      });
      break;
    }
    case "brand": {
      const brand = { ...obj(d.brand), ...pickStrings(obj(edit.value), BRAND_FIELDS as unknown as string[]), ...pickLists(obj(edit.value), ["vocabulary", "preferredTerminology", "forbiddenWords", "languages"]) };
      await writeDoc(tenantId, kbId, brandDoc(brand, lang), ai);
      await prisma.businessDiscovery.update({ where: { tenantId }, data: { brand: brand as any } });
      break;
    }
    default:
      throw new LearnedEditRefused("UNKNOWN_SECTION");
  }
  const view = await readLearned(tenantId);
  return edit.section === "policies" ? { ...view, ...(await employeePolicySync(tenantId, ai)) } : view;
}

/**
 * The go-live employee carries the policies as prompt lines too; after any
 * policy change they are rewritten so the prompt and retrieval agree. A studio-
 * customized employee is left alone and said: warnings ["employee_customized"].
 */
async function employeePolicySync(tenantId: string, ai: AiCall): Promise<{ employeeSync: string; warnings: string[] }> {
  const r = await ai(tenantId, "POST", "/api/ai-assist/onboarding-employee-policies", {});
  const sync = r.ok && typeof r.body?.data?.sync === "string" ? (r.body.data.sync as string) : "failed";
  return { employeeSync: sync, warnings: sync === "customized" ? ["employee_customized"] : [] };
}

/** The found-flags the legacy readers use (exchange and refund count as returns), as the scan sets them. */
function policyFlags(current: unknown, added: Array<{ kind: string }>): Record<string, boolean> {
  const flags: Record<string, boolean> = { ...obj(current) };
  for (const p of added) flags[p.kind === "exchange" || p.kind === "refund" ? "returns" : p.kind] = true;
  return flags;
}

function pagesOf(text: string, source: string) {
  const pages = [];
  for (let at = 0; at < text.length && pages.length < MAX_PAGES; at += PAGE_CHARS) {
    pages.push({ url: source, title: null, text: text.slice(at, at + PAGE_CHARS) });
  }
  return pages;
}

async function extractFrom(tenantId: string, kind: "policies" | "faq" | "profile", text: string, source: string, lang: string, ai: AiCall) {
  const r = await ai(tenantId, "POST", "/api/ai-assist/onboarding-extract", { kind, locale: lang, pages: pagesOf(text, source) });
  return r.ok && r.body?.data?.ok ? r.body.data.result : null;
}

/**
 * One pasted policy: the extraction fills its terms like a scanned one; when
 * it finds none, the owner's own words are the policy (never invented terms).
 * The pasted text is kept whole either way.
 */
async function pastedPolicy(tenantId: string, kind: string | undefined, rawText: unknown, lang: string, ai: AiCall) {
  if (!kind || !(POLICY_KINDS as readonly string[]).includes(kind)) throw new LearnedEditRefused("BAD_KIND");
  const text = typeof rawText === "string" ? rawText.trim() : "";
  if (!text) throw new LearnedEditRefused("TEXT_REQUIRED");
  if (text.length > PASTE_MAX) throw new LearnedEditRefused("TEXT_TOO_LONG");
  const found: any[] = (await extractFrom(tenantId, "policies", text, "pasted", lang, ai))?.policies ?? [];
  const best = found.find((p) => p.kind === kind) ?? found[0] ?? null;
  return {
    kind,
    summary: best?.summary ?? text.slice(0, 1500),
    terms: best?.terms ?? NO_TERMS,
    sourceUrl: "pasted",
    text,
  };
}

export class LearnedUploadRefused extends Error {
  constructor(readonly code: string, readonly status: number, readonly detail: Record<string, unknown> = {}) {
    super(code);
    this.name = "LearnedUploadRefused";
  }
}

/**
 * A file the owner gives when the site blocks reading: its text comes from the
 * AI service, then the scan's own extraction runs on it. Only what is missing
 * is added: a policy of a kind not yet learned, a question not already there,
 * profile and contact fields that are empty - never over what the owner or the
 * scan set.
 */
export async function learnFromFile(
  tenantId: string,
  upload: { body: Buffer; contentType: string },
  deps: { ai?: AiCall; aiFile?: AiFileCall } = {},
) {
  const ai = deps.ai ?? aiInternal;
  const aiFile = deps.aiFile ?? aiInternalFile;
  const d = await prisma.businessDiscovery.findUnique({
    where: { tenantId },
    select: { business: true, knowledge: true, communication: true },
  });
  if (!d) throw new LearnedUploadRefused("NOT_LEARNED", 404);

  const parsed = await aiFile(tenantId, "/api/ai-assist/onboarding-file-text", upload.body, upload.contentType);
  if (!parsed.ok) {
    const code = typeof parsed.body?.code === "string" ? parsed.body.code : "UPLOAD_FAILED";
    throw new LearnedUploadRefused(code, parsed.status >= 400 && parsed.status < 500 ? parsed.status : 502);
  }
  const filename = String(parsed.body?.data?.filename ?? "file");
  const text = String(parsed.body?.data?.text ?? "").trim();
  if (!text) throw new LearnedUploadRefused("NOTHING_FOUND", 422);
  const source = `upload:${filename}`;
  const lang = await scanLanguage(tenantId);

  const [pol, faq, prof] = await Promise.all([
    extractFrom(tenantId, "policies", text, source, lang, ai),
    extractFrom(tenantId, "faq", text, source, lang, ai),
    extractFrom(tenantId, "profile", text, source, lang, ai),
  ]);

  const knowledge = obj(d.knowledge);
  const structured = obj(knowledge.structured);
  const policies: any[] = Array.isArray(structured.policies) ? [...structured.policies] : [];
  // A file fills what is missing; it never replaces a policy already learned.
  // Found on dev: one FAQ line about shipping to Eilat came back as a thin
  // "shipping" policy and replaced the site's full one (costs, times, free
  // over). A known policy is the owner's to edit, so it is reported, not changed.
  const fromFile: any[] = (pol?.policies ?? []).map((p: any) => ({ ...p, sourceUrl: source }));
  const newPolicies = fromFile.filter((p, i) => !policies.some((x) => x.kind === p.kind) && fromFile.findIndex((y) => y.kind === p.kind) === i);
  const skippedPolicies = [...new Set(fromFile.filter((p) => !newPolicies.includes(p)).map((p) => p.kind as string))];
  policies.push(...newPolicies);
  const faqList: any[] = Array.isArray(structured.faq) ? [...structured.faq] : [];
  const known = new Set(faqList.map((f) => String(f.q).trim().toLowerCase()));
  let faqAdded = 0;
  for (const f of faq?.faq ?? []) {
    if (known.has(String(f.q).trim().toLowerCase())) continue;
    known.add(String(f.q).trim().toLowerCase());
    faqList.push({ q: f.q, a: f.a, sourceUrl: source });
    faqAdded++;
  }
  const business = obj(d.business);
  const communication = obj(d.communication);
  const contact = obj(communication.contact);
  const fill = (cur: Record<string, any>, next: Record<string, any>, keys: string[]) =>
    Object.fromEntries(keys.filter((k) => !cur[k] && typeof next[k] === "string" && next[k].trim()).map((k) => [k, next[k].trim()]));
  const union = (a: unknown, b: unknown) => [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])])];
  const profileFill = fill(business, obj(prof?.profile), ["name", "industry", "summary", "valueProp"]);
  const nextContact = {
    ...contact,
    ...fill(contact, obj(prof?.contact), ["address", "hours"]),
    emails: union(contact.emails, obj(prof?.contact).emails),
    phones: union(contact.phones, obj(prof?.contact).phones),
    whatsapp: union(contact.whatsapp, obj(prof?.contact).whatsapp),
  };
  const contactChanged = JSON.stringify(nextContact) !== JSON.stringify({ ...contact, emails: contact.emails ?? [], phones: contact.phones ?? [], whatsapp: contact.whatsapp ?? [] });
  const profileChanged = Object.keys(profileFill).length > 0 || contactChanged;

  if (!newPolicies.length && !faqAdded && !profileChanged) {
    throw new LearnedUploadRefused("NOTHING_FOUND", 422, { skipped: { policies: skippedPolicies } });
  }

  const kbId = await ensureWebsiteKb(tenantId);
  for (const p of newPolicies) await writeDoc(tenantId, kbId, policyDoc(p, lang), ai);
  if (faqAdded) await writeDoc(tenantId, kbId, faqDoc(faqList, lang), ai);
  const nextBusiness = { ...business, ...profileFill };
  if (profileChanged) await writeDoc(tenantId, kbId, profileDoc({ profile: nextBusiness, contact: nextContact }, lang), ai);
  await prisma.businessDiscovery.update({
    where: { tenantId },
    data: {
      knowledge: { ...knowledge, policies: policyFlags(knowledge.policies, newPolicies), structured: { ...structured, policies, faq: faqList } } as any,
      ...(profileChanged ? { business: nextBusiness as any, communication: { ...communication, contact: nextContact } as any } : {}),
    },
  });

  const sync = newPolicies.length ? await employeePolicySync(tenantId, ai) : { employeeSync: "unchanged", warnings: [] as string[] };
  return {
    ...(await readLearned(tenantId)),
    ...sync,
    added: { policies: newPolicies.map((p) => p.kind), faq: faqAdded, profile: profileChanged },
    // Kinds the file also had, left as they were: already learned.
    skipped: { policies: skippedPolicies },
    // The extraction reads the first 24,000 characters of a file.
    partial: text.length > PAGE_CHARS * MAX_PAGES,
  };
}

function pickStrings(v: Record<string, any>, keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.filter((k) => typeof v[k] === "string").map((k) => [k, v[k].trim()]));
}
function pickLists(v: Record<string, any>, keys: string[]): Record<string, string[]> {
  return Object.fromEntries(
    keys.filter((k) => Array.isArray(v[k])).map((k) => [k, v[k].filter((x: unknown) => typeof x === "string" && x.trim()).map((x: string) => x.trim())]),
  );
}

/** The language the scan wrote its documents in (recorded by the learn stages). */
async function scanLanguage(tenantId: string): Promise<string> {
  const d = await prisma.businessDiscovery.findUnique({ where: { tenantId }, select: { knowledge: true } });
  const lang = obj(obj(obj(d?.knowledge).structured)).lang;
  return typeof lang === "string" && lang ? lang : "he";
}

async function removeDoc(tenantId: string, kbId: string, key: string, ai: AiCall): Promise<void> {
  const doc = await prisma.knowledgeDocument.findFirst({
    where: { tenantId, knowledgeBaseId: kbId, metadata: { path: ["dedupeKey"], equals: key } },
    select: { id: true },
  });
  if (doc) await ai(tenantId, "DELETE", `/api/knowledge-bases/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(doc.id)}`);
}
