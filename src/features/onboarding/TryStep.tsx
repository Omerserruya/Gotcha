'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState, useTransition, type FormEvent } from 'react';

import {
  PREVIEW_QUESTION_MAX,
  type PreviewAnswer,
  type PreviewQuestions,
} from '@/api/contracts/onboarding';
import { CenteredLoader } from '@/design-system/primitives/loader/Loader';
import { Link, useRouter } from '@/i18n/navigation';
import { safeLinkUrl } from '@/lib/safe-url';

import {
  askPreview,
  finishOnboarding,
  teachAnswer,
  type FinishResult,
  type PreviewResult,
} from './onboarding-actions';
import styles from './Onboarding.module.css';

/** The longest answer the teach route takes. */
const ANSWER_MAX = 20_000;

type Refusal = Exclude<PreviewResult, { ok: true }>;

/**
 * 00h - Try it (design 6), over Backend's preview routes: the questions
 * (`onboarding-preview-questions`) - real unanswered ones first, "Asked N
 * times", then what customers usually ask - and how GOTCHA answers each one
 * from Knowledge, with its sources (`onboarding-preview-answer`).
 *
 * ★★ AN ANSWER IS ASKED FOR, NEVER DRAWN ON ARRIVAL: each one spends units.
 * ★★ `grounded: false` is said as a status - "Not in what GOTCHA learned
 *   yet" - with Fix as the way on; never presented as an answer that worked.
 * ★ Fix teaches (`/api/onboarding/teach`, the answer prefilled to edit), then
 *   asks the same question again and shows the new answer.
 * ★★ "Open my workspace" FINISHES (Omer, 2026-10-07: onboarding is a gate):
 *   the workspace goes live - or to payment, by `paymentRequired` - and the
 *   recommended employee is hired. Knowledge with nothing usable is said
 *   before the workspace opens, never a silent "all set".
 */
export function TryStep({
  questions,
  skippedCore,
}: {
  readonly questions: PreviewQuestions | null;
  /** 00g ended in "Skip for now": finish without a core system. */
  readonly skippedCore: boolean;
}) {
  const t = useTranslations('onboarding.try');
  const locale = useLocale();
  const router = useRouter();
  const [finishing, start] = useTransition();
  const [result, setResult] = useState<FinishResult | null>(null);

  const finish = () =>
    start(async () => {
      setResult(null);
      const done = await finishOnboarding({ skippedCore, locale });
      if (done.ok && done.payAt) {
        // Setup is done and it owes payment: the old app's payment pages, at the root.
        window.location.replace(done.payAt);
        return;
      }
      if (done.ok && done.knowledgeUsable !== false) {
        router.push('/home');
        return;
      }
      setResult(done);
    });

  if (finishing) {
    return <CenteredLoader label={t('finishing')} minHeight={320} />;
  }
  if (result?.ok) {
    // Live, but nothing in Knowledge it can answer from: said, then the workspace.
    return (
      <div className={styles.try} data-testid="try-no-knowledge">
        <h1 className={styles.title}>{t('noKnowledge.title')}</h1>
        <p className={styles.subtitle}>{t('noKnowledge.lead')}</p>
        <span className={styles.actions}>
          <Link href="/studio/knowledge" className={styles.secondary}>
            {t('noKnowledge.add')}
          </Link>
          <Link href="/home" className={styles.primary} data-testid="try-open-anyway">
            {t('open')}
          </Link>
        </span>
      </div>
    );
  }

  const real = questions?.real ?? [];
  const suggested = questions?.suggested ?? [];
  return (
    <div className={styles.try}>
      <h1 className={styles.title}>{t('title')}</h1>
      <p className={styles.subtitle} data-testid="try-lead">
        {questions === null
          ? t('unread')
          : real.length + suggested.length > 0
            ? t('subtitle')
            : t('leadNone')}
      </p>
      {real.length > 0 ? (
        <section className={styles.tryGroup} data-testid="try-real">
          <h2 className={styles.tryGroupTitle}>{t('real')}</h2>
          <ul className={styles.questions}>
            {real.map((q, i) => (
              <QuestionCard
                key={q.id ?? `real-${i}`}
                question={q.question}
                askCount={q.askCount}
                testid={`try-real-${i}`}
              />
            ))}
          </ul>
        </section>
      ) : null}
      {suggested.length > 0 ? (
        <section className={styles.tryGroup} data-testid="try-suggested">
          <h2 className={styles.tryGroupTitle}>{t('suggested')}</h2>
          <ul className={styles.questions}>
            {suggested.map((q, i) => (
              <QuestionCard
                key={`suggested-${i}`}
                question={q.question}
                testid={`try-suggested-${i}`}
              />
            ))}
          </ul>
        </section>
      ) : null}
      <AskYourOwn />
      {result && !result.ok ? (
        <p className={styles.problem} role="alert" data-testid="try-refused">
          {t(`refused.${result.reason}`)}{' '}
          {result.reason === 'core_system_required' ? (
            <Link href="/onboarding/truth" className={styles.inlineLink}>
              {t('refused.toTruth')}
            </Link>
          ) : result.reason === 'needs_profile' ? (
            <Link href="/onboarding/website" className={styles.inlineLink}>
              {t('refused.toWebsite')}
            </Link>
          ) : null}
        </p>
      ) : null}
      <span className={styles.actions}>
        <button type="button" className={styles.primary} onClick={finish} data-testid="try-open">
          {t('open')}
        </button>
        <span className={styles.quiet}>{t('nextOnHome')}</span>
      </span>
    </div>
  );
}

/** Why an answer did not come, in the screen's words. */
function RefusalLine({ refusal, testid }: { readonly refusal: Refusal; readonly testid: string }) {
  const t = useTranslations('onboarding.try.refusedAsk');
  return (
    <span className={styles.problem} role="alert" data-testid={testid}>
      {refusal.reason === 'rate' ? t('rate', { seconds: refusal.seconds }) : t(refusal.reason)}
    </span>
  );
}

/** "Ask your own question": always there, its problems next to it. */
function AskYourOwn() {
  const t = useTranslations('onboarding.try');
  const locale = useLocale();
  const [draft, setDraft] = useState('');
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [asked, setAsked] = useState<readonly { question: string; answer: PreviewAnswer }[]>([]);
  const [asking, start] = useTransition();

  const ask = (e: FormEvent) => {
    e.preventDefault();
    const question = draft.trim();
    if (question === '') {
      setRefusal({ ok: false, reason: 'required' });
      return;
    }
    start(async () => {
      setRefusal(null);
      const got = await askPreview(question, locale);
      if (got.ok) {
        setAsked((was) => [...was, { question, answer: got.answer }]);
        setDraft('');
        return;
      }
      setRefusal(got);
    });
  };

  return (
    <section className={styles.tryGroup}>
      {asked.length > 0 ? (
        <ul className={styles.questions} data-testid="try-own-answers">
          {asked.map((one, i) => (
            <QuestionCard
              key={`own-${i}`}
              question={one.question}
              answered={one.answer}
              testid={`try-own-${i}`}
            />
          ))}
        </ul>
      ) : null}
      <form className={styles.askOwn} onSubmit={ask}>
        <label className={styles.tryGroupTitle} htmlFor="try-own-question">
          {t('own.label')}
        </label>
        <span className={styles.askOwnRow}>
          <input
            id="try-own-question"
            className={styles.askOwnField}
            value={draft}
            maxLength={PREVIEW_QUESTION_MAX}
            dir="auto"
            placeholder={t('own.placeholder')}
            onChange={(e) => setDraft(e.target.value)}
            data-testid="try-own-field"
          />
          <button
            type="submit"
            className={styles.secondary}
            disabled={asking}
            data-testid="try-own-ask"
          >
            {asking ? t('answering') : t('own.ask')}
          </button>
        </span>
        {refusal ? <RefusalLine refusal={refusal} testid="try-own-refused" /> : null}
      </form>
    </section>
  );
}

type CardState =
  | { readonly at: 'idle' }
  | { readonly at: 'answered'; readonly answer: PreviewAnswer; readonly relearned: boolean }
  | { readonly at: 'good'; readonly answer: PreviewAnswer }
  | { readonly at: 'fixing'; readonly answer: PreviewAnswer };

function QuestionCard({
  question,
  askCount,
  answered,
  testid,
}: {
  readonly question: string;
  /** A real question: how often customers asked it. */
  readonly askCount?: number;
  /** Asked already (the question asked in the field). */
  readonly answered?: PreviewAnswer;
  readonly testid: string;
}) {
  const t = useTranslations('onboarding.try');
  const locale = useLocale();
  const [state, setState] = useState<CardState>(
    answered ? { at: 'answered', answer: answered, relearned: false } : { at: 'idle' },
  );
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [fix, setFix] = useState('');
  const [taughtFailed, setTaughtFailed] = useState(false);
  const [busy, start] = useTransition();

  const ask = (relearned: boolean) =>
    start(async () => {
      setRefusal(null);
      const got = await askPreview(question, locale);
      if (got.ok) setState({ at: 'answered', answer: got.answer, relearned });
      else setRefusal(got);
    });

  const openFix = (answer: PreviewAnswer) => {
    // A grounded answer is the starting point; "not learned" has nothing to keep.
    setFix(answer.grounded ? answer.answer : '');
    setTaughtFailed(false);
    setState({ at: 'fixing', answer });
  };

  const teach = () =>
    start(async () => {
      setTaughtFailed(false);
      const ok = await teachAnswer(question, fix, locale);
      if (!ok) {
        setTaughtFailed(true);
        return;
      }
      // Taught: the same question again, and the new answer.
      setRefusal(null);
      const got = await askPreview(question, locale);
      if (got.ok) setState({ at: 'answered', answer: got.answer, relearned: true });
      else {
        setState({ at: 'idle' });
        setRefusal(got);
      }
    });

  return (
    <li className={styles.question} data-testid={testid}>
      <span className={styles.asked}>
        <bdi dir="auto">{question}</bdi>
      </span>
      {askCount !== undefined ? (
        <span className={styles.quiet}>{t('asked', { count: askCount })}</span>
      ) : null}

      {state.at === 'idle' ? (
        <span className={styles.teachActions}>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => ask(false)}
            disabled={busy}
            data-testid={`${testid}-see`}
          >
            {busy ? t('answering') : t('see')}
          </button>
        </span>
      ) : (
        <Answer answer={state.answer} testid={testid} />
      )}

      {state.at === 'answered' && state.relearned ? (
        <p className={styles.learnedLine} role="status" data-testid={`${testid}-relearned`}>
          {t('relearned')}
        </p>
      ) : null}

      {state.at === 'answered' ? (
        <span className={styles.teachActions}>
          {state.answer.grounded ? (
            <>
              <button
                type="button"
                className={styles.secondary}
                onClick={() => setState({ at: 'good', answer: state.answer })}
                data-testid={`${testid}-good`}
              >
                {t('good')}
              </button>
              <button
                type="button"
                className={styles.secondary}
                onClick={() => openFix(state.answer)}
                data-testid={`${testid}-fix`}
              >
                {t('fix')}
              </button>
            </>
          ) : (
            <button
              type="button"
              className={styles.primary}
              onClick={() => openFix(state.answer)}
              data-testid={`${testid}-fix`}
            >
              {t('fix')}
            </button>
          )}
        </span>
      ) : null}

      {state.at === 'good' ? (
        <p className={styles.learnedLine} role="status" data-testid={`${testid}-good-line`}>
          {t('goodLine')}
        </p>
      ) : null}

      {state.at === 'fixing' ? (
        <span className={styles.teach}>
          <textarea
            className={styles.voiceText}
            value={fix}
            maxLength={ANSWER_MAX}
            rows={3}
            dir="auto"
            onChange={(e) => setFix(e.target.value)}
            placeholder={t('placeholder')}
            aria-label={t('answerLabel')}
            data-testid={`${testid}-fix-text`}
          />
          {taughtFailed ? (
            <span className={styles.problem} role="alert" data-testid={`${testid}-fix-failed`}>
              {t('failed')}
            </span>
          ) : null}
          <span className={styles.teachActions}>
            <button
              type="button"
              className={styles.primary}
              onClick={teach}
              disabled={busy || fix.trim() === ''}
              data-testid={`${testid}-teach`}
            >
              {busy ? t('teaching') : t('save')}
            </button>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => setState({ at: 'answered', answer: state.answer, relearned: false })}
              disabled={busy}
            >
              {t('cancel')}
            </button>
          </span>
        </span>
      ) : null}

      {refusal ? <RefusalLine refusal={refusal} testid={`${testid}-refused`} /> : null}
    </li>
  );
}

/** GOTCHA's answer, and where it came from - or, ungrounded, that it does not know yet. */
function Answer({ answer, testid }: { readonly answer: PreviewAnswer; readonly testid: string }) {
  const t = useTranslations('onboarding.try');
  return (
    <>
      <span className={styles.answerRow}>
        <span className={styles.answerAvatar} aria-hidden="true">
          G
        </span>
        <span className={styles.answerText} data-testid={`${testid}-answer`}>
          <bdi dir="auto">{answer.answer}</bdi>
        </span>
      </span>
      <span className={styles.answerSources}>
        {answer.grounded ? (
          answer.sources.map((source) => {
            const href = external(source.sourceUrl);
            const label = t('source', { title: source.title });
            return href ? (
              <a
                key={source.documentId}
                className={styles.sourceChip}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                data-testid={`${testid}-source`}
              >
                {label}
              </a>
            ) : (
              <span
                key={source.documentId}
                className={styles.sourceChip}
                data-testid={`${testid}-source`}
              >
                {label}
              </span>
            );
          })
        ) : (
          <span className={styles.notLearnedTag} data-testid={`${testid}-not-learned`}>
            {t('notLearned')}
          </span>
        )}
      </span>
    </>
  );
}

/** A source's page, only as an outside http(s) link; anything else is no link. */
function external(url: string | null): string | null {
  const safe = safeLinkUrl(url);
  return safe && /^https?:\/\//i.test(safe) ? safe : null;
}
