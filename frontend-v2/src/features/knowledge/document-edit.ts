import type { KnowledgeDocumentDetail } from '@/api/contracts/knowledge';
import { WEBSITE_SOURCE_TYPES } from './knowledge-type';

/**
 * K11 (Omer, 2026-10-13): what the drawer lets a person change about one
 * knowledge item, decided from what the platform really does to it - read
 * from the writers, not from the item's label.
 *
 * ── WHAT A SAVE DOES (services/ai `knowledge.ts`, PUT /:id/documents/:docId) ──
 * A new title is stored (trimmed; blank keeps the old one). New content
 * replaces the stored text and, only when it differs, sets the item back to
 * `pending`, drops its old vectors first and reads it again - re-chunked,
 * re-embedded, and its summary remade (the summary is keyed on a hash of the
 * content). Blank content is ignored and the old text kept - so a blank
 * content is refused here rather than "saved" as nothing.
 *
 * `manualEdit: true` is stamped into the metadata and stays there. Only the
 * website scan's reconciler reads it (`reconcile()` in packages/shared
 * `onboarding-projection.ts`): an item it made (`origin: 'onboarding'`) and
 * a person edited is reported `preserved` and never rewritten - its title
 * included. Every save from the drawer is a person's edit, so every save
 * stamps it; on an item the scan never made, nothing reads it.
 *
 * ── SO, PER KIND ──
 *   typed, file, a page added by hand, answers…  name and content.
 *   the website scan's items                     name and content, and the
 *       screen says the edit is kept through the next scan.
 *   longer than the drawer shows (`truncated`)   the name only: the drawer
 *       holds the first 20 000 characters, and saving them back would cut
 *       the rest off.
 *   Google Drive, Confluence                     neither, and no delete: the
 *       hourly sync (`upsertSyncedDocument`) ignores `manualEdit` and rewrites
 *       title and content when the file changes, and re-creates a deleted
 *       item while the file is still selected. The drawer says where it is
 *       changed instead.
 */
export type EditScope =
  | { readonly kind: 'full' }
  | { readonly kind: 'title' }
  | { readonly kind: 'synced'; readonly place: 'drive' | 'confluence' };

/** The fields the drawer needs to edit or delete an item - and no more. */
export type EditableDocument = Pick<
  KnowledgeDocumentDetail,
  'id' | 'knowledgeBaseId' | 'title' | 'type' | 'content' | 'truncated' | 'metadata'
>;

export function editableOf(document: KnowledgeDocumentDetail): EditableDocument {
  return {
    id: document.id,
    knowledgeBaseId: document.knowledgeBaseId,
    title: document.title,
    type: document.type,
    content: document.content,
    truncated: document.truncated,
    metadata: document.metadata,
  };
}

export function editScope(document: EditableDocument): EditScope {
  switch (document.type) {
    case 'google_drive':
    case 'drive':
      return { kind: 'synced', place: 'drive' };
    case 'confluence':
      return { kind: 'synced', place: 'confluence' };
    default:
      return document.truncated ? { kind: 'title' } : { kind: 'full' };
  }
}

/**
 * The line under the editor, or none:
 *   scan  the website scan made it (`origin: 'onboarding'`): the edit is kept
 *         through the next scan - Backend's words, 2026-10-13. `reconcile()`
 *         reports a `manualEdit` item `preserved` instead of rewriting it,
 *         and since Backend 196fea72 also when the page is gone from the site
 *         (`removeMissing`) and in duplicate cleanup.
 *   page  a page's text, added by hand - the page itself is not changed
 *   file  an uploaded file's text - the file itself is not changed
 * `url_text` is how the scan stores a crawled page (onboarding-knowledge
 * .service.ts `createDoc`); it is a page all the same.
 */
export function editNote(document: EditableDocument): 'scan' | 'page' | 'file' | null {
  if (document.metadata?.origin === 'onboarding') return 'scan';
  if (WEBSITE_SOURCE_TYPES.has(document.type)) return 'page';
  return document.type === 'file' ? 'file' : null;
}

/**
 * What a save sends besides `manualEdit`: only what changed. The title is
 * compared trimmed (the route trims it); the content exactly as typed, and
 * never on a title-only item. `null`: nothing changed.
 */
export function documentChange(
  document: EditableDocument,
  draft: { readonly title: string; readonly content: string },
): { readonly title?: string; readonly content?: string } | null {
  const title = draft.title.trim();
  const change: { title?: string; content?: string } = {};
  if (title !== document.title) change.title = title;
  if (editScope(document).kind === 'full' && draft.content !== (document.content ?? '')) {
    change.content = draft.content;
  }
  return change.title === undefined && change.content === undefined ? null : change;
}
