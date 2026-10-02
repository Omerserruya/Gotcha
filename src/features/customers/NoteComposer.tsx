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
export function NoteComposer({
  contactId,
  customerName = null,
}: {
  readonly contactId: string;
  /** For 02's placeholder, "Write a note about Dana…". */
  readonly customerName?: string | null;
}) {
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
    /* 02's composer: one white card, a 1px dark edge, the controls along its foot. */
    <div className={styles.composer} data-testid="note-composer">
      <label className="srOnly" htmlFor="note-body">
        {t('teamNotes.write')}
      </label>
      <textarea
        id="note-body"
        className={styles.composerInput}
        data-testid="note-body"
        value={body}
        rows={2}
        placeholder={
          customerName
            ? t('teamNotes.placeholderNamed', { name: customerName })
            : t('teamNotes.placeholder')
        }
        onChange={(event) => setBody(event.target.value)}
        disabled={isPending}
      />

      <div className={styles.composerBar}>
        {/*
          ★ THE ONE CONTROL THE CUT KEPT, AND IT SAYS WHAT IT DOES.
          02's segmented "Team only | GOTCHA may use" — the consequence, not a
          field name, because the consequence is that the sentence can come
          back out of the bot's mouth. Team only is the default: it fails
          closed, as the column does. What each choice does is its tooltip.
        */}
        <div
          className={styles.segmented}
          role="radiogroup"
          aria-label={t('teamNotes.aiUsable')}
          title={aiUsable ? t('teamNotes.aiUsableOn') : t('teamNotes.aiUsableOff')}
        >
          {/*
            ★ BUTTONS WITH aria-checked, NOT NATIVE RADIOS. React sets a
            controlled radio's `checked` as a property, never the attribute,
            so the chosen half was marked in colour and nowhere in the DOM —
            measured on dev as "no option selected". The state is now on the
            element, where an inspector and a screen reader both read it.
          */}
          <button
            type="button"
            role="radio"
            className={styles.segment}
            data-testid="note-team-only"
            aria-checked={!aiUsable}
            data-on={!aiUsable ? '' : undefined}
            onClick={() => setAiUsable(false)}
            disabled={isPending}
          >
            {t('teamNotes.teamOnly')}
          </button>
          <button
            type="button"
            role="radio"
            className={styles.segment}
            data-testid="note-ai-usable"
            aria-checked={aiUsable}
            data-on={aiUsable ? '' : undefined}
            onClick={() => setAiUsable(true)}
            disabled={isPending}
          >
            {t('teamNotes.mayUse')}
          </button>
        </div>
        <span className="srOnly">
          {aiUsable ? t('teamNotes.aiUsableOn') : t('teamNotes.aiUsableOff')}
        </span>

        <button
          type="button"
          className={styles.composerSubmit}
          data-testid="note-save"
          disabled={isPending || empty || tooLong}
          onClick={submit}
        >
          {isPending ? t('teamNotes.saving') : t('teamNotes.save')}
        </button>
      </div>

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
