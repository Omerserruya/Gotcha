/**
 * A one or two line summary of what a knowledge document contains (B3,
 * 2026-10-12), for the Knowledge center's rows and drawer.
 *
 * Generated once when the document is processed (ingest or update), stored on
 * KnowledgeDocument.metadata.summary, and only regenerated when the content or
 * the workspace's system language changes - never per page view. Written in the
 * workspace's system language (Tenant.defaultLocale), the language GOTCHA uses
 * for what it writes for the business, not the customer-reply language.
 *
 * Never fails the document: a summary that cannot be made is simply absent.
 */
import { createHash } from "crypto";
import { prisma } from "@chatcenter/shared";
import { generateResponse, getMicroModel } from "./ai.service";

export const SUMMARY_MAX = 160;
const CONTENT_FOR_SUMMARY = 6000;

export interface StoredSummary {
  text: string;
  lang: "he" | "en";
  /** sha256 of the content it summarises (first 16 hex), to know when it is stale. */
  hash: string;
  at: string;
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content ?? "").digest("hex").slice(0, 16);
}

/** The summary text to serve, or null when there is none. */
export function summaryOf(metadata: unknown): string | null {
  const s = (metadata as any)?.summary;
  return typeof s?.text === "string" && s.text.trim() ? s.text : null;
}

/** One line, no dashes, at most SUMMARY_MAX characters, cut on a word. */
export function cleanSummary(raw: string): string {
  let t = String(raw ?? "")
    .replace(/[\u2013\u2014\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'\u201c\u201d\u05f4]+|["'\u201c\u201d\u05f4]+$/g, "")
    .trim();
  if (t.length > SUMMARY_MAX) {
    const cut = t.slice(0, SUMMARY_MAX - 1);
    const sp = cut.lastIndexOf(" ");
    t = `${(sp > SUMMARY_MAX / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, "")}\u2026`;
  }
  return t;
}

async function systemLanguage(tenantId: string): Promise<"he" | "en"> {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { defaultLocale: true } }).catch(() => null);
  return String(t?.defaultLocale ?? "").toLowerCase().startsWith("he") ? "he" : "en";
}

/**
 * Make (or keep) the stored summary for one document. Returns what happened,
 * for the backfill's count; never throws.
 */
export async function ensureDocumentSummary(documentId: string): Promise<"created" | "fresh" | "empty" | "failed" | "missing"> {
  try {
    const doc = await prisma.knowledgeDocument.findUnique({
      where: { id: documentId },
      select: { id: true, tenantId: true, title: true, content: true, metadata: true },
    });
    if (!doc) return "missing";
    const content = (doc.content ?? "").trim();
    if (!content) return "empty";
    const lang = await systemLanguage(doc.tenantId);
    const hash = contentHash(doc.content);
    const current = (doc.metadata as any)?.summary as StoredSummary | undefined;
    if (current?.hash === hash && current?.lang === lang && current?.text) return "fresh";

    const languageName = lang === "he" ? "Hebrew" : "English";
    const res = await generateResponse({
      tenantId: doc.tenantId,
      model: getMicroModel(),
      temperature: 0.2,
      maxTokens: 120,
      metadata: { type: "summary", purpose: "knowledge_document_summary", documentId: doc.id },
      messages: [
        {
          role: "system",
          content:
            `Write ONE or TWO short sentences in ${languageName} saying what this document contains, ` +
            `for a list of a business's knowledge. At most ${SUMMARY_MAX} characters. ` +
            `Describe the content (topics, what a reader learns); do not quote it, do not start with "This document". ` +
            `No preamble, no quotes, no dashes.`,
        },
        { role: "user", content: `Title: ${doc.title}\n\n${content.slice(0, CONTENT_FOR_SUMMARY)}` },
      ],
    });
    const text = cleanSummary(res.content);
    if (!text) return "failed";

    // Re-read so a concurrent metadata write is merged, not overwritten.
    const latest = await prisma.knowledgeDocument.findUnique({ where: { id: doc.id }, select: { metadata: true, content: true } });
    if (!latest || contentHash(latest.content) !== hash) return "failed"; // changed meanwhile; the next process run summarises it
    const summary: StoredSummary = { text, lang, hash, at: new Date().toISOString() };
    await prisma.knowledgeDocument.update({
      where: { id: doc.id },
      data: { metadata: { ...((latest.metadata as Record<string, unknown> | null) ?? {}), summary } as any },
    });
    return "created";
  } catch (err: any) {
    console.warn(`[knowledge-summary] ${documentId}: ${err?.message ?? err}`);
    return "failed";
  }
}
