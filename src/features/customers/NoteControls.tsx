'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { editNote, removeNote, type NoteWriteResult } from './note-actions';
import styles from './Customers.module.css';

/**
 * Edit and delete, offered only to the author.
 *
 * ★ THE SCREEN MIRRORS `requireOwnEditable` RATHER THAN DISCOVERING IT.
 * Both routes answer 403 `not_the_author` for anybody else, so a screen that
 * drew these controls for everyone would be offering a button that fails -
 * and the failure would read as a fault rather than as the rule it is. The
 * caller checks `canEdit` before mounting this at all.
 *
 * The 403 is still handled, because the author of a note can change: the
 * route compares against the CURRENT user id, and our copy of it came from a
 * read that may be a page-load old.
 *
 * ── DELETE IS CONFIRMED, BECAUSE THE AUTHOR CANNOT UNDO IT ──
 * The row survives - *"a customer's history should not develop holes"* - but
 * it leaves every read this product has, so from the merchant's side it is
 * gone for good. The confirm is a plain second press rather than a dialog:
 * the destructive-action rule this project has applied elsewhere.
 */
export function NoteControls({
  contactId,
  noteId,
  body,
}: {
  readonly contactId: string;
  readonly noteId: string;
  readonly body: string;
}) {
  const t = useTranslations('customers');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(body);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<NoteWriteResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function save() {
    setResult(null);
    startTransition(async () => {
      const outcome = await editNote(contactId, noteId, draft);
      setResult(outcome);
      if (outcome.ok) setEditing(false);
    });
  }

  function remove() {
    setResult(null);
    startTransition(async () => {
      setResult(await removeNote(contactId, noteId));
    });
  }

  return (
    <div className={styles.noteControls} data-testid={`note-controls-${noteId}`}>
      {editing ? (
        <>
          <textarea
            className={styles.composerInput}
            data-testid={`note-edit-${noteId}`}
            value={draft}
            rows={3}
            onChange={(event) => setDraft(event.target.value)}
            disabled={isPending}
          />
          <button
            type="button"
            className={styles.noteAction}
            data-testid={`note-edit-save-${noteId}`}
            disabled={isPending || !draft.trim()}
            onClick={save}
          >
            {t('teamNotes.save')}
          </button>
          <button
            type="button"
            className={styles.noteAction}
            data-testid={`note-edit-cancel-${noteId}`}
            disabled={isPending}
            onClick={() => {
              setDraft(body);
              setEditing(false);
            }}
          >
            {t('teamNotes.cancel')}
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className={styles.noteAction}
            data-testid={`note-edit-start-${noteId}`}
            disabled={isPending}
            onClick={() => setEditing(true)}
          >
            {t('teamNotes.edit')}
          </button>
          <button
            type="button"
            className={styles.noteAction}
            data-testid={`note-delete-${noteId}`}
            data-confirming={confirming ? 'yes' : 'no'}
            disabled={isPending}
            onClick={() => (confirming ? remove() : setConfirming(true))}
          >
            {confirming ? t('teamNotes.deleteConfirm') : t('teamNotes.delete')}
          </button>
        </>
      )}

      {result && !result.ok ? (
        <p className={styles.noteProblem} data-testid={`note-problem-${noteId}`}>
          {result.reason === 'not_the_author'
            ? t('teamNotes.notTheAuthor')
            : t('teamNotes.writeFailed')}
        </p>
      ) : null}
    </div>
  );
}
