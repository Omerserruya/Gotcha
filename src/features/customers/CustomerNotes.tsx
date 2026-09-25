import { getFormatter, getTranslations } from 'next-intl/server';

import {
  canEdit,
  destinationOf,
  pushFailed,
  wasEdited,
  type Note,
} from '@/api/contracts/customer-notes';

import { NoteComposer } from './NoteComposer';
import { NoteControls } from './NoteControls';
import styles from './Customers.module.css';

/**
 * Screen 04f — what your team wrote about this person.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CLASSIC NOTES, PER OMER'S CUT
 * ════════════════════════════════════════════════════════════════════════════
 * Who wrote it, what it says, when, and edit or delete by the author. **No
 * pinning, no revision history, no AI-suggestion accept flow** — `pinned`,
 * `editHistory` and `status: AI_SUGGESTED` all exist on the table and are
 * left unused rather than given surfaces.
 *
 * `editHistory` is read for one bit only: **that** a note was edited. The
 * previous bodies are deliberately not shown, which is the difference
 * between "this was corrected" and a revisions UI.
 *
 * ── THE ONE CONTROL THAT SURVIVED THE CUT, AND WHY ──
 * `aiUsable` — *"GOTCHA may use this"* versus *"team only"*, default off.
 * It is the only axis a merchant cannot infer from anything else on screen,
 * and it decides whether the note leaves our database at all:
 *
 *   note → elected CRM → recent_crm_notes → the brief → the model's context
 *
 * Verified end to end by the platform, and the push is the only chokepoint.
 * Without the control every note is team-only and nobody is told why.
 *
 * ── AND `visibility` IS NOT THE SAME QUESTION ──
 * TEAM versus PRIVATE is who may READ it. The column's own comment:
 * *"conflating the two is a bug either way round — a note can be readable by
 * the whole team and still be something the bot must never repeat."* 04f
 * shows no control for it and sends no value, so the column keeps its
 * default. Both axes nonetheless gate the CRM push, which is why the
 * destination sentence below is read from the server rather than derived
 * from the toggle this screen does show.
 */
export async function CustomerNotes({
  notes,
  contactId,
  viewerUserId,
}: {
  readonly notes: readonly Note[] | null;
  readonly contactId: string;
  readonly viewerUserId: string | null;
}) {
  const t = await getTranslations('customers');
  const format = await getFormatter();

  return (
    <section className={styles.notesPanel} data-testid="team-notes">
      <h2 className={styles.detailHeading}>{t('teamNotes.title')}</h2>

      {/*
        The composer is offered even when the list failed to read: writing a
        note does not depend on having read the old ones, and removing the
        control would turn a read failure into a lost thought.
      */}
      <NoteComposer contactId={contactId} />

      {notes === null ? (
        /*
         * ★ A FAILED READ, NOT AN EMPTY ONE. "Nobody has written anything
         * about this person" is a claim, and it is the wrong one to make
         * from a request that did not come back.
         */
        <p className={styles.unavailable} data-testid="team-notes-unread">
          {t('teamNotes.unread')}
        </p>
      ) : notes.length === 0 ? (
        <p className={styles.notesEmpty} data-testid="team-notes-empty">
          {t('teamNotes.none')}
        </p>
      ) : (
        <ol className={styles.noteList}>
          {notes.map((note) => {
            const destination = destinationOf(note);
            return (
              <li key={note.id} className={styles.note} data-testid={`note-${note.id}`}>
                <div className={styles.noteHead}>
                  <span className={styles.noteAuthor} data-testid={`note-author-${note.id}`}>
                    {note.authorName}
                  </span>
                  <time className={styles.noteWhen} dateTime={note.createdAt}>
                    {format.dateTime(new Date(note.createdAt), {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </time>
                  {/*
                    THAT it was edited, never what it said before. A note that
                    can be corrected silently is a record of whatever it says
                    now — but the previous bodies are a revisions UI, which
                    this screen does not have.
                  */}
                  {wasEdited(note) ? (
                    <span className={styles.noteEdited} data-testid={`note-edited-${note.id}`}>
                      {t('teamNotes.edited')}
                    </span>
                  ) : null}
                </div>

                <p className={styles.noteBody}>{note.body}</p>

                {/*
                  ★★ WHERE THIS NOTE LIVES, IN THE SERVER'S WORDS.
                  Eight outcomes, because `NOT_APPLICABLE` alone reaches the
                  screen by five different paths and two of them are
                  different repairs — "no CRM connected" and "this person is
                  not linked to a record in the one you have" send somebody
                  to two different places.
                */}
                <p
                  className={pushFailed(note) ? styles.noteDestFailed : styles.noteDest}
                  data-destination={destination}
                  data-testid={`note-where-${note.id}`}
                >
                  {destination === 'synced'
                    ? t('teamNotes.where.synced', {
                        system: note.externalSystem ?? t('teamNotes.yourCrm'),
                      })
                    : destination === 'failed'
                      ? /*
                         ★ NEVER RENDER A FAILED PUSH AS SAVED. There WAS a
                         target and it refused. The provider's own words are
                         shown rather than paraphrased, for the same reason
                         04d renders its chips verbatim.
                        */
                        t('teamNotes.where.failed', {
                          reason: note.externalSyncError ?? t('teamNotes.noReason'),
                        })
                      : t(`teamNotes.where.${destination}` as 'teamNotes.where.private')}
                </p>

                {canEdit(note, viewerUserId) ? (
                  <NoteControls contactId={contactId} noteId={note.id} body={note.body} />
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
