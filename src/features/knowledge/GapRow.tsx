'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { GAP_ANSWER_MAX, type UnansweredQuestion } from '@/api/contracts/knowledge';
import { UserText } from '@/design-system/primitives/text/UserText';
import { typedDir } from '@/lib/typed-dir';

import { answerGap, type GapAnswer } from './gap-actions';
import styles from './Knowledge.module.css';

/**
 * One question GOTCHA could not answer, and 08's Answer: "Answer one and
 * every employee learns it". The answer is written in place and sent as
 * typed; while it is learned the row says so; once learned it says every
 * employee knows it now (the list reads it as answered on the next visit).
 * Saved but not learned: said - the question stays open, nothing claims it
 * was answered.
 */
export function GapRow({
  question,
  asked,
}: {
  readonly question: UnansweredQuestion;
  /** "Asked 14 times by 9 people", worded by the page. */
  readonly asked: string;
}) {
  const t = useTranslations('knowledge.gaps');
  const [draft, setDraft] = useState<string | null>(null);
  const [result, setResult] = useState<GapAnswer | null>(null);
  const [isPending, startTransition] = useTransition();

  if (result?.ok) {
    return (
      <li className={styles.gap} data-testid={`gap-${question.id}`} data-state="learned">
        <span className={styles.gapText}>
          <span className={styles.gapQuestion}>
            <UserText>{question.question}</UserText>
          </span>
          <span
            className={styles.gapLearned}
            role="status"
            data-testid={`gap-learned-${question.id}`}
          >
            {t('learned')}
          </span>
        </span>
      </li>
    );
  }

  const ready = draft !== null && draft.trim() !== '' && draft.length <= GAP_ANSWER_MAX;
  return (
    <li className={styles.gapItem} data-testid={`gap-${question.id}`}>
      <div className={styles.gap}>
        <span className={styles.gapText}>
          <span className={styles.gapQuestion}>
            <UserText>{question.question}</UserText>
          </span>
          {/* One person twenty times ≠ twenty people once: kept apart. */}
          <span className={styles.gapCount}>{asked}</span>
        </span>
        {draft === null ? (
          <button
            type="button"
            className={styles.answer}
            onClick={() => {
              setResult(null);
              setDraft('');
            }}
            data-testid={`gap-answer-${question.id}`}
          >
            {t('answer')}
          </button>
        ) : null}
      </div>
      {draft !== null ? (
        <form
          className={styles.gapForm}
          onSubmit={(e) => {
            e.preventDefault();
            if (!ready || isPending) return;
            startTransition(async () => {
              setResult(await answerGap(question.id, draft));
            });
          }}
        >
          <textarea
            className={styles.gapInput}
            value={draft}
            rows={3}
            maxLength={GAP_ANSWER_MAX}
            dir={typedDir(draft)}
            aria-label={t('answerLabel', { question: question.question })}
            placeholder={t('placeholder')}
            // The person just asked to answer it.
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            data-testid={`gap-input-${question.id}`}
          />
          <p className={styles.gapHint}>{t('hint')}</p>
          {result && !result.ok ? (
            <p
              className={styles.gapProblem}
              role="alert"
              data-testid={`gap-problem-${question.id}`}
            >
              {t(`problem.${result.reason}`)}
            </p>
          ) : null}
          <span className={styles.gapActions}>
            <button
              type="submit"
              className={styles.gapSave}
              disabled={!ready || isPending}
              data-testid={`gap-save-${question.id}`}
            >
              {isPending ? t('learning') : t('save')}
            </button>
            <button
              type="button"
              className={styles.gapCancel}
              disabled={isPending}
              onClick={() => {
                setDraft(null);
                setResult(null);
              }}
            >
              {t('cancel')}
            </button>
          </span>
        </form>
      ) : null}
    </li>
  );
}
