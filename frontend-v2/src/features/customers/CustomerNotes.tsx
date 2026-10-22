import { getFormatter, getTranslations } from 'next-intl/server';

import {
  canEdit,
  destinationOf,
  pushFailed,
  wasEdited,
  type Note,
} from '@/api/contracts/customer-notes';

import { Link } from '@/i18n/navigation';

import { initialsOf, shortDate } from './CustomerScreen';
import { NoteComposer } from './NoteComposer';
import { NoteControls } from './NoteControls';
import styles from './Customers.module.css';

/**
 * 04f's filters, less 02's "Pinned": Omer's "classic notes only" ruling for
 * this screen stands until he lifts it, and the platform cannot read or
 * write `pinned` yet in any case (the list's `select` omits it).
 */
export const NOTE_FILTERS = ['all', 'mayUse', 'teamOnly'] as const;
export type NoteFilter = (typeof NOTE_FILTERS)[number];

export function parseNoteFilter(raw: string | undefined): NoteFilter {
  return (NOTE_FILTERS as readonly string[]).includes(raw ?? '') ? (raw as NoteFilter) : 'all';
}

/**
 * Screen 04f - what your team wrote about this person.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CLASSIC NOTES, PER OMER'S CUT
 * ════════════════════════════════════════════════════════════════════════════
 * Who wrote it, what it says, when, and edit or delete by the author. **No
 * pinning, no revision history, no AI-suggestion accept flow** - `pinned`,
 * `editHistory` and `status: AI_SUGGESTED` all exist on the table and are
 * left unused rather than given surfaces.
 *
 * `editHistory` is read for one bit only: **that** a note was edited. The
 * previous bodies are deliberately not shown, which is the difference
 * between "this was corrected" and a revisions UI.
 *
 * ── THE ONE CONTROL THAT SURVIVED THE CUT, AND WHY ──
 * `aiUsable` - *"GOTCHA may use this"* versus *"team only"*, default off.
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
 * *"conflating the two is a bug either way round - a note can be readable by
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
  filter = 'all',
  customerName = null,
}: {
  readonly notes: readonly Note[] | null;
  readonly contactId: string;
  readonly viewerUserId: string | null;
  readonly filter?: NoteFilter;
  readonly customerName?: string | null;
}) {
  const t = await getTranslations('customers');
  const format = await getFormatter();
  const now = new Date();
  const shown = (notes ?? []).filter((note) =>
    filter === 'mayUse' ? note.aiUsable : filter === 'teamOnly' ? !note.aiUsable : true,
  );

  return (
    <section className={styles.notesPanel} data-testid="team-notes">
      {/*
        The composer is offered even when the list failed to read: writing a
        note does not depend on having read the old ones, and removing the
        control would turn a read failure into a lost thought.
      */}
      <NoteComposer contactId={contactId} customerName={customerName} />

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
      ) : shown.length === 0 ? (
        <p className={styles.notesEmpty} data-testid="team-notes-filter-empty">
          {t('teamNotes.filterEmpty')}
        </p>
      ) : (
        <ol className={styles.noteList}>
          {shown.map((note) => {
            const destination = destinationOf(note);
            return (
              <li key={note.id} className={styles.note} data-testid={`note-${note.id}`}>
                {/* 28px: a person in stone; a note the AI wrote (no author user) in violet. */}
                <span
                  className={styles.noteDisc}
                  data-ai={note.authorUserId === null ? '' : undefined}
                  aria-hidden="true"
                >
                  {initialsOf(note.authorName)}
                </span>
                <div className={styles.noteMain}>
                  <div className={styles.noteHead}>
                    <span className={styles.noteAuthor} data-testid={`note-author-${note.id}`}>
                      {note.authorName}
                    </span>
                    <time className={styles.noteWhen} dateTime={note.createdAt}>
                      {shortDate(note.createdAt, now, format, t('card.today'))}
                    </time>
                    {/* Who may hear it: the aiUsable axis, in 02's words. */}
                    <span
                      className={styles.noteChip}
                      data-ai={note.aiUsable ? '' : undefined}
                      data-testid={`note-chip-${note.id}`}
                    >
                      {note.aiUsable ? t('teamNotes.mayUse') : t('teamNotes.teamOnly')}
                    </span>
                    {/*
                    THAT it was edited, never what it said before. A note that
                    can be corrected silently is a record of whatever it says
                    now - but the previous bodies are a revisions UI, which
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
                  different repairs - "no CRM connected" and "this person is
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
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/** 04f's filters: All, GOTCHA may use, Team only. */
export async function NoteFilters({
  contactId,
  current,
}: {
  readonly contactId: string;
  readonly current: NoteFilter;
}) {
  const t = await getTranslations('customers');
  return (
    <>
      {NOTE_FILTERS.map((key) => (
        <Link
          key={key}
          href={{
            pathname: `/customers/${contactId}`,
            query: key === 'all' ? { tab: 'notes' } : { tab: 'notes', filter: key },
          }}
          className={styles.filterPill}
          aria-current={current === key ? 'true' : undefined}
          data-testid={`note-filter-${key}`}
        >
          {t(`teamNotes.filter.${key}`)}
        </Link>
      ))}
    </>
  );
}

/**
 * 04f's side: the counts, and what GOTCHA reads from here.
 *
 * "What GOTCHA reads" is the notes marked for it - the same rule as
 * `promptSafeNotes` on the platform (`aiUsable: true`), so the list is what
 * the model can see, not a summary of it. 02's "Shown in the Inbox" block is
 * the pinned notes, and waits with Pin.
 */
export async function NotesSide({ notes }: { readonly notes: readonly Note[] | null }) {
  const t = await getTranslations('customers');
  const format = await getFormatter();
  const live = notes?.filter((note) => note.deletedAt === null) ?? null;
  const count = (n: number | null) => (n === null ? '-' : format.number(n));
  const reads = live?.filter((note) => note.aiUsable) ?? [];

  return (
    <>
      <section className={styles.sideBlock} data-testid="notes-counts">
        <h2 className={styles.sideEyebrow}>{t('teamNotes.side.heading')}</h2>
        <dl className={`${styles.worth} ${styles.pattern}`}>
          <div>
            <dt>{t('teamNotes.side.notes')}</dt>
            <dd className={styles.worthValue}>{count(live ? live.length : null)}</dd>
          </div>
          <div>
            <dt>{t('teamNotes.side.mayUse')}</dt>
            <dd className={styles.worthValue}>{count(live ? reads.length : null)}</dd>
          </div>
          <div>
            <dt>{t('teamNotes.side.teamOnly')}</dt>
            <dd className={styles.worthValue}>{count(live ? live.length - reads.length : null)}</dd>
          </div>
        </dl>
      </section>
      <section className={styles.sideBlock} data-testid="notes-reads">
        <h2 className={styles.sideEyebrow}>{t('teamNotes.side.reads')}</h2>
        {reads.length > 0 ? (
          <ul className={styles.remembers}>
            {reads.slice(0, 4).map((note) => (
              <li key={note.id} className={styles.notesRead}>
                {note.body}
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.sideNone}>{live === null ? '-' : t('teamNotes.side.readsNone')}</p>
        )}
        <p className={styles.notesCaption}>{t('teamNotes.side.readsCaption')}</p>
      </section>
    </>
  );
}
