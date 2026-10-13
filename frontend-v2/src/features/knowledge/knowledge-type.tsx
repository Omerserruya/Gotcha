/*
 * No 'use client' here: the Add sheet (a client component), the list on 08
 * and the item's drawer (server components) all draw from this one map, and a
 * function exported from a client module is a reference the server cannot
 * call.
 */
import { FileText, FolderSync, Globe, PencilLine, type LucideIcon } from 'lucide-react';

import { ADD_WAYS, type AddWay } from './add/add-way';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ K8 (Omer, 2026-10-12) - EACH KIND OF KNOWLEDGE HAS ONE ICON, HERE
 * ════════════════════════════════════════════════════════════════════════════
 * The four kinds are the Add sheet's four ways in: a document, a page on the
 * website, a Drive folder, or typed in. The sheet's cards, each row on 08 and
 * the item's drawer all draw `KnowledgeTypeIcon`, so the three cannot drift.
 *
 * Line icons from the app's set (lucide), as 08 draws its ways in: `globe`
 * and `folder-sync` are 02's own glyphs for the website and the synced Drive
 * folder. The Drive card is not drawn with Google's logo: it connects
 * Confluence too, and its connectors carry their own logos inside it.
 *
 * Decorative: always beside words that already name the kind.
 */
export type KnowledgeType = AddWay;
export const KNOWLEDGE_TYPES: readonly KnowledgeType[] = ADD_WAYS;

export const KNOWLEDGE_TYPE_ICONS: Readonly<Record<KnowledgeType, LucideIcon>> = {
  document: FileText,
  page: Globe,
  drive: FolderSync,
  text: PencilLine,
};

/**
 * Which of the four a stored document is, from the writers' `sourceType`
 * (read from their write sites): `file` an uploaded document; `url` and
 * `onboarding_scan` a page of the website; `google_drive` and `drive` from a
 * Drive folder; `text` typed in.
 *
 * Anything else - Confluence, past conversations, setup answers, a value
 * nobody wrote down - is none of the four, and gets no icon rather than a
 * borrowed one.
 */
/**
 * ★★ A PAGE OF THE WEBSITE, HOWEVER IT CAME IN - the one list every place
 * that sorts a document by `sourceType` reads:
 *   url              a page added by hand ("a page on the site")
 *   onboarding_scan  the scan's own summary of the site
 *   url_text         a page the scan crawled (auth onboarding-knowledge
 *                    .service.ts writes `url` as `url_text`)
 * `url_text` was in none of the lists, so every crawled page read "Other"
 * with no icon (K11's hand-back, 2026-10-13).
 */
export const WEBSITE_SOURCE_TYPES: ReadonlySet<string> = new Set([
  'url',
  'onboarding_scan',
  'url_text',
]);

/** The two the website SCAN writes - a source made only of these came from it. */
export const SCANNED_SOURCE_TYPES: ReadonlySet<string> = new Set(['onboarding_scan', 'url_text']);

export function knowledgeTypeOf(sourceType: string): KnowledgeType | null {
  if (WEBSITE_SOURCE_TYPES.has(sourceType)) return 'page';
  switch (sourceType) {
    case 'file':
      return 'document';
    case 'google_drive':
    case 'drive':
      return 'drive';
    case 'text':
      return 'text';
    default:
      return null;
  }
}

export function KnowledgeTypeIcon({
  type,
  size = 16,
  className,
}: {
  readonly type: KnowledgeType;
  readonly size?: number;
  readonly className?: string;
}) {
  const Icon = KNOWLEDGE_TYPE_ICONS[type];
  return <Icon className={className} size={size} aria-hidden="true" data-knowledge-type={type} />;
}
