'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import type { UnansweredQuestion } from '@/api/contracts/knowledge';
import { Link } from '@/i18n/navigation';

import { teachAnswer } from './onboarding-actions';
import styles from './Onboarding.module.css';

/** The longest answer the route takes. */
const ANSWER_MAX = 20_000;

/**
 * 00h - Try it (design 6). Real questions, never invented: the newest ones
 * customers asked that GOTCHA could not answer (`unanswered-questions`).
 *
 * ★★ NO ANSWER IS DRAWN. Nothing that answers from Knowledge runs before
 *   go-live: the test chat is a live workspace's, and onboarding's
 *   employee-chat tunes the persona from the business summary (and saves
 *   it) - an answer from it would claim knowledge it never read. So the
 *   answer's place says why, and each question can be TAUGHT - the design's
 *   Fix: the answer goes into Knowledge, where every employee answers from.
 * ★ "Open my workspace" goes to Home. It does not go live.
 */
export function TryStep({
  questions,
}: {
  readonly questions: readonly UnansweredQuestion[] | null;
}) {
  const t = useTranslations('onboarding.try');
  return (
    <div className={styles.try}>
      <h1 className={styles.title}>
        {questions && questions.length > 0 ? t('title') : t('titleNone')}
      </h1>
      <p className={styles.subtitle} data-testid="try-lead">
        {questions === null ? t('unread') : questions.length > 0 ? t('lead') : t('leadNone')}
      </p>
      {questions && questions.length > 0 ? (
        <>
          <p className={styles.notYet} data-testid="try-why">
            {t('answersWhy')}
          </p>
          <ul className={styles.questions}>
            {questions.map((q) => (
              <Question key={q.id} question={q} />
            ))}
          </ul>
        </>
      ) : null}
      <span className={styles.actions}>
        <Link href="/home" className={styles.primary} data-testid="try-open">
          {t('open')}
        </Link>
        <span className={styles.quiet}>{t('nextOnHome')}</span>
      </span>
    </div>
  );
}

function Question({ question }: { readonly question: UnansweredQuestion }) {
  const t = useTranslations('onboarding.try');
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState('');
  const [taught, setTaught] = useState<'idle' | 'learned' | 'failed'>('idle');
  const [isTeaching, start] = useTransition();

  const teach = () =>
    start(async () => {
      const ok = await teachAnswer(question.question, answer, locale);
      setTaught(ok ? 'learned' : 'failed');
      if (ok) setOpen(false);
    });

  return (
    <li className={styles.question} data-testid={`try-question-${question.id}`}>
      <span className={styles.asked}>
        <bdi dir="auto">{question.question}</bdi>
      </span>
      {question.timesAsked > 1 ? (
        <span className={styles.quiet}>{t('asked', { count: question.timesAsked })}</span>
      ) : null}
      {taught === 'learned' ? (
        <p className={styles.learnedLine} role="status" data-testid="try-learned">
          {t('learned')}
        </p>
      ) : open ? (
        <span className={styles.teach}>
          <textarea
            className={styles.voiceText}
            value={answer}
            maxLength={ANSWER_MAX}
            rows={3}
            dir="auto"
            onChange={(e) => setAnswer(e.target.value)}
            placeholder={t('placeholder')}
            aria-label={t('answerLabel')}
            data-testid="try-answer"
          />
          {taught === 'failed' ? (
            <span className={styles.problem} role="alert" data-testid="try-failed">
              {t('failed')}
            </span>
          ) : null}
          <span className={styles.teachActions}>
            <button
              type="button"
              className={styles.primary}
              onClick={teach}
              disabled={isTeaching || answer.trim() === ''}
              data-testid="try-save"
            >
              {isTeaching ? t('teaching') : t('save')}
            </button>
            <button type="button" className={styles.secondary} onClick={() => setOpen(false)}>
              {t('cancel')}
            </button>
          </span>
        </span>
      ) : (
        <span className={styles.teachActions}>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => setOpen(true)}
            data-testid="try-teach"
          >
            {t('teach')}
          </button>
        </span>
      )}
    </li>
  );
}
