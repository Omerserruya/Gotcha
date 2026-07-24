// Map a raw KnowledgeDocument.sourceType (as written by ingestion:
// "file"/"text"/"url"/"google_drive"/"confluence", plus seed values like
// "document"/"manual") onto one of the localized typeLabels buckets, so the
// Knowledge tab's TYPE column always shows a real translated label - never a
// raw i18n key. Kept in its own module (not the AI Studio page, which as a
// Next.js App Router page may only export a default) so both the page and its
// test can import it and assert the mapping stays in sync with ingestion.
export type KnowledgeSourceBucket = "file" | "url" | "text" | "drive" | "confluence";

export function canonicalDocType(raw: string): KnowledgeSourceBucket {
  const s = raw.toLowerCase();
  if (["url", "website", "web", "page", "crawl", "link"].includes(s)) return "url";
  if (["text", "faq", "manual", "qa", "question", "note"].includes(s)) return "text";
  if (["google_drive", "gdrive", "drive"].includes(s)) return "drive";
  if (s === "confluence") return "confluence";
  // file, upload, document, pdf, doc, docx and any unknown → a generic file.
  return "file";
}
