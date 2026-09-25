import { describe, expect, it } from 'vitest';

import {
  canEdit,
  destinationOf,
  noteListSchema,
  noteSchema,
  pushFailed,
  wasEdited,
  NOTE_STATUSES,
  NOTE_SYNC_STATUSES,
  type Note,
} from './customer-notes';

const note = (over: Partial<Note> = {}): Note =>
  noteSchema.parse({
    id: 'n1',
    body: 'Prefers delivery after 4pm.',
    authorName: 'Dana Levi',
    createdAt: '2026-09-18T09:21:00.000Z',
    updatedAt: '2026-09-18T09:21:00.000Z',
    ...over,
  });

describe('★★ where the note lives — five roads to NOT_APPLICABLE', () => {
  it('★★ tells "no CRM connected" apart from "this person is not in it"', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * THE DISTINCTION THIS PROJECT HAS NOW MADE ON SIX SCREENS.
     * ════════════════════════════════════════════════════════════════════════
     * Both arrive as `NOT_APPLICABLE`. `no_crm_configured` means connect one;
     * `no_crm_link` means you already did and this person is not matched to a
     * record in it. Telling the second merchant to connect a CRM sends them
     * to a settings page where everything is already correct.
     */
    expect(destinationOf(note({ externalSyncError: 'no_crm_configured' }))).toBe('no_crm');
    expect(destinationOf(note({ externalSyncError: 'no_crm_link' }))).toBe('not_linked');
  });

  it('★ separates the two reasons a note was withheld on purpose', () => {
    // Both are deliberate and neither is a failure, but they are different
    // decisions: one is about who may READ it, one about whether the bot may
    // USE it. Conflating them is a bug either way round.
    expect(destinationOf(note({ externalSyncError: 'private' }))).toBe('private');
    expect(destinationOf(note({ externalSyncError: 'not_ai_usable' }))).toBe('not_ai_usable');
  });

  it('★ an unrecognised reason is still "kept here", never invented', () => {
    // `null` covers two causes the wire cannot separate — no conversation to
    // resolve a CRM contact from, and no forwarded authorization. To a
    // merchant they are the same fact, and a reason we do not know is not a
    // reason to guess at a better one.
    expect(destinationOf(note({ externalSyncError: null }))).toBe('nothing_to_push');
    expect(destinationOf(note({ externalSyncError: 'something_new' }))).toBe('nothing_to_push');
  });

  it('★★ a FAILED push is never any kind of "kept here"', () => {
    /*
     * The lesson of the stub that answered 200 and persisted nothing. There
     * WAS a target and it refused; reporting that as a note quietly kept in
     * GOTCHA would be the same lie one layer up.
     */
    const failed = note({ externalSyncStatus: 'FAILED', externalSyncError: 'rate_limited' });
    expect(destinationOf(failed)).toBe('failed');
    expect(pushFailed(failed)).toBe(true);
    // And the status wins over the error string, which is also set on failure.
    expect(destinationOf(note({ externalSyncStatus: 'FAILED', externalSyncError: 'private' }))).toBe(
      'failed',
    );
  });

  it('★ PENDING is "we do not know yet", not a synced note in a hurry', () => {
    // Written before the fetch. A reader can see it mid-push, and if the
    // process died between the two writes it stays PENDING for good — so
    // neither optimistic answer is available.
    expect(destinationOf(note({ externalSyncStatus: 'PENDING' }))).toBe('pending');
  });

  it('reports a synced note as synced', () => {
    expect(destinationOf(note({ externalSyncStatus: 'SYNCED', externalSystem: 'hubspot' }))).toBe(
      'synced',
    );
  });
});

describe('★★ only the author may change a note', () => {
  it('★★ mirrors requireOwnEditable, so no control is offered that 403s', () => {
    /*
     * `PATCH` and `DELETE` both throw `not_the_author` for anybody else. A
     * screen drawing the control for everyone offers a button that fails,
     * and the failure reads as a fault rather than as the rule it is.
     */
    expect(canEdit(note({ authorUserId: 'u1' }), 'u1')).toBe(true);
    expect(canEdit(note({ authorUserId: 'u1' }), 'u2')).toBe(false);
  });

  it('★★ an unknown viewer edits nothing, rather than everything', () => {
    /*
     * `viewerUserId` is null when `/api/auth/me` failed. Comparing null to a
     * null `authorUserId` — which is what an AI-written note carries —
     * would hand every reader the controls for every AI note.
     */
    expect(canEdit(note({ authorUserId: null }), null)).toBe(false);
    expect(canEdit(note({ authorUserId: 'u1' }), null)).toBe(false);
  });

  it('nobody edits a deleted note, including its author', () => {
    // The route answers 409 `note_deleted` before it checks authorship.
    expect(canEdit(note({ authorUserId: 'u1', deletedAt: '2026-09-19T00:00:00.000Z' }), 'u1')).toBe(
      false,
    );
  });
});

describe('★ the shape is the platform’s', () => {
  it('★★ carries all three statuses, not the two this screen asks for', () => {
    /*
     * 04f requests only PUBLISHED. `REJECTED` — a suggestion somebody
     * declined, kept so the AI stops re-proposing it — is still in the enum,
     * and one missing `z.enum` member rejects the whole response rather than
     * the one row.
     */
    expect([...NOTE_STATUSES]).toEqual(['PUBLISHED', 'AI_SUGGESTED', 'REJECTED']);
    expect(noteSchema.parse({ ...note(), status: 'REJECTED' }).status).toBe('REJECTED');
    expect([...NOTE_SYNC_STATUSES]).toEqual(['NOT_APPLICABLE', 'PENDING', 'SYNCED', 'FAILED']);
  });

  it('★ says THAT a note was edited without showing what it said', () => {
    // Classic notes, per the cut: no revisions UI. The one bit that survives
    // is that the body is not what was first written.
    expect(wasEdited(note())).toBe(false);
    expect(wasEdited(note({ editHistory: [{ at: '2026-09-18T10:02:00.000Z' }] }))).toBe(true);
  });

  it('★★ a list response missing `notes` FAILS rather than reading as empty', () => {
    /*
     * "Nobody has written a note about this person yet" is a claim, and a
     * defaulted `[]` would make it from a response that said nothing — the
     * `customerAuditSchema` defect, on a screen that makes the same kind of
     * statement.
     */
    expect(() => noteListSchema.parse({ contactId: 'c1' })).toThrow();
    expect(() => noteListSchema.parse({ notes: [] })).toThrow();
    expect(noteListSchema.parse({ notes: [], contactId: 'c1' }).notes).toEqual([]);
  });

  it('★ a note with no author name is not a note this screen can render', () => {
    // Denormalised on the column precisely so it always exists: "an
    // unattributable note is worth less than no note".
    const { authorName: _dropped, ...anonymous } = note();
    expect(() => noteSchema.parse(anonymous)).toThrow();
  });
});
