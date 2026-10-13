import { describe, expect, it } from 'vitest';

import { knowledgeDocumentDetailSchema } from '@/api/contracts/knowledge';

import { documentChange, editableOf, editNote, editScope } from './document-edit';

/** The route's own shape (`knowledge.ts` GET), through the real contract. */
const doc = (over: Record<string, unknown> = {}) =>
  editableOf(
    knowledgeDocumentDetailSchema.parse({
      id: 'd1',
      knowledgeBaseId: 'kb-1',
      title: 'Shipping terms',
      type: 'text',
      content: 'We ship in 2 days.',
      contentLength: 18,
      truncated: false,
      metadata: null,
      ...over,
    }),
  );

describe('★★ K11 - what can be changed is what the platform keeps', () => {
  it('typed, file, a page, an answer: title and content', () => {
    for (const type of ['text', 'file', 'url', 'url_text', 'onboarding_scan', 'readiness_answer']) {
      expect(editScope(doc({ type }))).toEqual({ kind: 'full' });
    }
  });

  it('★ longer than the drawer holds: the title only - saving the first 20 000 back would cut the rest', () => {
    expect(editScope(doc({ truncated: true, contentLength: 30000 }))).toEqual({ kind: 'title' });
  });

  it('★ Drive and Confluence: nothing - their sync rewrites an edit and brings a deleted item back', () => {
    expect(editScope(doc({ type: 'google_drive' }))).toEqual({ kind: 'synced', place: 'drive' });
    expect(editScope(doc({ type: 'drive' }))).toEqual({ kind: 'synced', place: 'drive' });
    expect(editScope(doc({ type: 'confluence' }))).toEqual({
      kind: 'synced',
      place: 'confluence',
    });
  });

  it('the line under the editor follows who made it, then what it is', () => {
    const scan = { metadata: { origin: 'onboarding', manualEdit: true, dedupeKey: 'k' } };
    expect(editNote(doc({ type: 'url_text', ...scan }))).toBe('scan');
    expect(editNote(doc({ type: 'url', ...scan }))).toBe('scan');
    expect(editNote(doc({ type: 'onboarding_scan', ...scan }))).toBe('scan');
    expect(editNote(doc({ type: 'url' }))).toBe('page');
    expect(editNote(doc({ type: 'onboarding_scan' }))).toBe('page');
    expect(editNote(doc({ type: 'file' }))).toBe('file');
    expect(editNote(doc({ type: 'text' }))).toBeNull();
    // A metadata of another shape is no origin - one line, never the drawer.
    expect(editNote(doc({ type: 'file', metadata: 'onboarding' }))).toBe('file');
  });

  it('a save carries only what changed: the title trimmed, the content as typed', () => {
    const d = doc();
    expect(
      documentChange(d, { title: ' Shipping terms ', content: 'We ship in 2 days.' }),
    ).toBeNull();
    expect(documentChange(d, { title: 'Terms', content: 'We ship in 2 days.' })).toEqual({
      title: 'Terms',
    });
    expect(documentChange(d, { title: 'Shipping terms', content: ' Next day. ' })).toEqual({
      content: ' Next day. ',
    });
  });

  it('★ a title-only item never sends content, whatever the draft holds', () => {
    expect(
      documentChange(doc({ truncated: true }), { title: 'Terms', content: 'cut off' }),
    ).toEqual({ title: 'Terms' });
  });
});
