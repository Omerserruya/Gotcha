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
  aiInternal,
  brandDoc,
  ensureWebsiteKb,
  faqDoc,
  policyDoc,
  profileDoc,
  writeDoc,
} from "./learn";

const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});
export const faqId = (q: string) => crypto.createHash("sha1").update(q.trim().toLowerCase()).digest("hex").slice(0, 12);

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
  return readLearned(tenantId);
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
