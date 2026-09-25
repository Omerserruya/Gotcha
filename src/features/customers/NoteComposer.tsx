'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { NOTE_MAX_LENGTH } from '@/api/contracts/customer-notes';

import { createNote, type NoteWriteResult } from './note-actions';
import styles from './Customers.module.css';

/**
 * Writing a note — and deciding whether GOTCHA may use it.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE TOGGLE DEFAULTS OFF AND IS RESET AFTER EVERY WRITE
 * ════════════════════════════════════════════════════════════════════════════
 * `aiUsable` decides whether the note is mirrored into the merchant's CRM —
 * and once it is there it returns through `recent_crm_notes` into the brief
 * and into the model's context, where no filter of ours can reach it.
 *
 * So it fails closed, exactly as the column does: *"a note is prompt-unsafe
 * until somebody says otherwise."* Carrying the previous note's setting
 * forward would be the most natural convenience to add and the wrong one —
 * somebody who marked one note AI-usable has not said anything about the
 * next, and the cost of guessing wrong is the bot repeating a private remark
 * to the customer it is about.
 */
export function NoteComposer({ contactId }: { readonly contactId: string }) {
  const t = useTranslations('customers');
  const [body, setBody] = useState('');
  const [aiUsable, setAiUsable] = useState(false);
  const [result, setResult] = useState<NoteWriteResult | null>(null);
  const [isPending, startTransition] = useTransition();

  const tooLong = body.trim().length > NOTE_MAX_LENGTH;
  const empty = body.trim().length === 0;

  function submit() {
    setResult(null);
    startTransition(async () => {
      const outcome = await createNote(contactId, body, aiUsable);
      setResult(outcome);
      if (outcome.ok) {
        setBody('');
        // Reset, deliberately. See the header: the next note is a new
        // decision and inherits nothing from this one.
        setAiUsable(false);
      }
    });
  }

  return (
    <div className={styles.composer} data-testid="note-composer">
      <label className={styles.composerLabel} htmlFor="note-body">
        {t('teamNotes.write')}
      </label>
      <textarea
        id="note-body"
        className={styles.composerInput}
        data-testid="note-body"
        value={body}
        rows={3}
        onChange={(event) => setBody(event.target.value)}
        disabled={isPending}
      />

      {/*
        ★ THE ONE CONTROL THE CUT KEPT, AND IT SAYS WHAT IT DOES.
        "Team only" versus "GOTCHA may use this" — phrased as the consequence
        rather than as a field name, because the consequence is that the
        sentence can come back out of the bot's mouth.
      */}
      <label className={styles.composerToggle}>
        <input
          type="checkbox"
          data-testid="note-ai-usable"
          checked={aiUsable}
          onChange={(event) => setAiUsable(event.target.checked)}
          disabled={isPending}
        />
        <span>{t('teamNotes.aiUsable')}</span>
        <span className={styles.composerHint}>
          {aiUsable ? t('teamNotes.aiUsableOn') : t('teamNotes.aiUsableOff')}
        </span>
      </label>

      <button
        type="button"
        className={styles.composerSubmit}
        data-testid="note-save"
        disabled={isPending || empty || tooLong}
        onClick={submit}
      >
        {isPending ? t('teamNotes.saving') : t('teamNotes.save')}
      </button>

      {tooLong ? (
        <p className={styles.noteProblem} data-testid="note-too-long">
          {t('teamNotes.tooLong', { max: NOTE_MAX_LENGTH })}
        </p>
      ) : null}

      {result && !result.ok ? (
        <p className={styles.noteProblem} data-testid="note-problem">
          {result.reason === 'not_the_author'
            ? t('teamNotes.notTheAuthor')
            : result.reason === 'too_long'
              ? t('teamNotes.tooLong', { max: NOTE_MAX_LENGTH })
              : result.reason === 'empty'
                ? t('teamNotes.empty')
                : t('teamNotes.writeFailed')}
        </p>
      ) : null}
    </div>
  );
}
