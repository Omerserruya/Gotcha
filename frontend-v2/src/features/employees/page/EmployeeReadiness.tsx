'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState, useTransition } from 'react';

import type { Employee, ReadinessQuestion } from '@/api/contracts/employees';
import { UserText } from '@/design-system/primitives/text/UserText';
import { Link, useRouter } from '@/i18n/navigation';
import { typedDir } from '@/lib/typed-dir';

import { answerReadinessQuestion, type ReadinessAnswerResult } from './readiness-answer-actions';
import { rerunReadiness, type ReadinessRunResult } from './readiness-actions';
import {
  MAX_READINESS_ANSWER,
  readinessAnswered,
  readinessGaps,
  RESOLVE_AT,
  type ReadinessRun,
} from './readiness';
import styles from './EmployeePage.module.css';

/** How often the page reads again while a test runs. */
export const READINESS_POLL_MS = 10_000;

/**
 * H7 (Omer, 2026-10-13): the employee's readiness, on its page.
 *
 *   the score       0-100, and how many of the questions it is fully ready for
 *   Not ready for   the questions with no answer, then the partial ones, each
 *                   with the test's reason
 *   What to add     the recommendations, each with where it is resolved
 *   Run again       `POST builder/:id/readiness-test` - one LLM call
 *
 * The test runs by itself after a hire and stores its report on the employee.
 * While a run is stored as running, "Checking readiness…", and the page reads
 * again every few seconds; a failed run says why, in words, with Run again.
 * Nothing is ever run on opening the page.
 *
 * ★★ E2 (Omer, 2026-10-14): minimized by default - one line (the score, how
 * many questions are still open, when) and "Show all" opens the rest in
 * place. A question it is not ready for can be answered right here: the
 * answer goes into the knowledge, and the next run counts it covered. One a
 * person answered is listed as answered, never as a gap.
 */
export function EmployeeReadiness({
  employeeId,
  report,
  run,
}: {
  readonly employeeId: string;
  readonly report: Employee['readinessReport'];
  /** The last run, from its stored status (readiness.ts). */
  readonly run: ReadinessRun;
}) {
  const t = useTranslations('employees.readiness');
  const format = useFormatter();
  const router = useRouter();
  const [problem, setProblem] = useState<
    Exclude<ReadinessRunResult, { ok: true }>['reason'] | null
  >(null);
  const [pressed, startRun] = useTransition();
  const [open, setOpen] = useState(false);
  const stored = run.state === 'running';
  const checking = pressed || stored;
  // The stored status says it better: a failed run with its reason, a slow one as running.
  const said =
    problem === null ||
    (problem === 'failed' && run.state === 'failed') ||
    (problem === 'slow' && stored)
      ? null
      : problem;

  useEffect(() => {
    if (!stored) return;
    const timer = setInterval(() => router.refresh(), READINESS_POLL_MS);
    return () => clearInterval(timer);
  }, [stored, router]);

  const rerun = () =>
    startRun(async () => {
      setProblem(null);
      const result = await rerunReadiness(employeeId);
      if (!result.ok) setProblem(result.reason);
      // Read again either way: a slow run is stored as running, a failed one says why.
      router.refresh();
    });

  const gaps = report ? readinessGaps(report.questions) : [];
  const answered = report ? readinessAnswered(report.questions) : [];
  const recommendations = report?.recommendations.filter((r) => r.title.trim() !== '') ?? [];

  return (
    <section className={styles.section} data-testid="profile-readiness">
      <div className={styles.sectionHead}>
        <h2 className={styles.title}>{t('title')}</h2>
        {checking ? null : (
          <button type="button" className={styles.add} onClick={rerun} data-testid="readiness-run">
            {report ? t('rerun') : t('run')}
          </button>
        )}
      </div>

      {!checking && run.state === 'failed' ? (
        <p className={styles.problem} role="status" data-testid="readiness-failed">
          {t(`failed.${run.failure}`)}
        </p>
      ) : null}

      {checking ? (
        <p className={styles.quiet} role="status" data-testid="readiness-checking">
          {t('checking')}
        </p>
      ) : report === null ? (
        <p className={styles.quiet} data-testid="readiness-never">
          {t('never')}
        </p>
      ) : (
        <>
          <p className={styles.readinessScore} data-testid="readiness-score">
            {report.score === null ? null : (
              <strong>{t('score', { score: Math.round(report.score) })}</strong>
            )}
            {report.totals && report.totals.total > 0 ? (
              <span data-testid="readiness-totals">
                {t('totals', { full: report.totals.full, total: report.totals.total })}
              </span>
            ) : null}
            <span data-testid="readiness-open">
              {gaps.length > 0 ? t('open', { count: gaps.length }) : t('noGaps')}
            </span>
            {report.generatedAt ? (
              <span className={styles.edited}>
                {t('tested', { when: format.relativeTime(new Date(report.generatedAt)) })}
              </span>
            ) : null}
            <button
              type="button"
              className={styles.linkButton}
              aria-expanded={open}
              aria-controls="readiness-details"
              data-testid="readiness-toggle"
              onClick={() => setOpen((was) => !was)}
            >
              {open ? t('showLess') : t('showAll')}
            </button>
          </p>

          {/* Not drawn while minimized - never `hidden` (a display class beats it). */}
          {open ? (
            <div id="readiness-details" className={styles.readinessDetails}>
              <div className={styles.block} data-testid="readiness-gaps">
                <h3 className={styles.subtitle}>{t('gaps')}</h3>
                {gaps.length === 0 ? (
                  <p className={styles.quiet} data-testid="readiness-no-gaps">
                    {t('noGaps')}
                  </p>
                ) : (
                  <ul className={styles.rows}>
                    {gaps.map((gap, i) => (
                      <GapRow
                        key={gap.id ?? `${i}:${gap.question}`}
                        employeeId={employeeId}
                        gap={gap}
                        index={i}
                      />
                    ))}
                  </ul>
                )}
              </div>

              {answered.length > 0 ? (
                <div className={styles.block} data-testid="readiness-answered">
                  <h3 className={styles.subtitle}>{t('answered.title')}</h3>
                  <ul className={styles.rows}>
                    {answered.map((question, i) => (
                      <li
                        key={question.id ?? `${i}:${question.question}`}
                        className={styles.readinessItem}
                        data-testid={`readiness-answered-${i}`}
                      >
                        <span className={styles.readinessLine}>
                          <UserText>{question.question}</UserText>
                          <span className={styles.state}>{t('answered.state')}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {recommendations.length > 0 ? (
                <div className={styles.block} data-testid="readiness-recommendations">
                  <h3 className={styles.subtitle}>{t('recommendations')}</h3>
                  <ul className={styles.rows}>
                    {recommendations.map((recommendation, i) => {
                      const at = RESOLVE_AT[recommendation.type];
                      return (
                        <li
                          key={i}
                          className={styles.readinessItem}
                          data-testid={`readiness-recommendation-${i}`}
                        >
                          <span className={styles.readinessLine}>
                            <UserText>{recommendation.title}</UserText>
                            {at ? (
                              <Link
                                href={at}
                                className={styles.readinessGo}
                                data-testid={`readiness-recommendation-${i}-go`}
                              >
                                {t(at === '/settings/systems' ? 'go.systems' : 'go.knowledge')}
                              </Link>
                            ) : null}
                          </span>
                          {recommendation.detail.trim() !== '' ? (
                            <span className={styles.note}>
                              <UserText>{recommendation.detail}</UserText>
                            </span>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      )}

      {said ? (
        <p className={styles.problem} role="alert" data-testid="readiness-problem">
          {t(`problem.${said}`)}
        </p>
      ) : null}
    </section>
  );
}

/**
 * One question it is not ready for, and - for a person who knows - its
 * answer, written here and added to the knowledge (E2).
 */
function GapRow({
  employeeId,
  gap,
  index,
}: {
  readonly employeeId: string;
  readonly gap: ReadinessQuestion;
  readonly index: number;
}) {
  const t = useTranslations('employees.readiness');
  const router = useRouter();
  const [writing, setWriting] = useState(false);
  const [answer, setAnswer] = useState('');
  const [result, setResult] = useState<ReadinessAnswerResult | null>(null);
  const [saving, startSave] = useTransition();
  const words = answer.trim();
  const id = `readiness-answer-${index}`;

  const add = () =>
    startSave(async () => {
      setResult(null);
      const done = await answerReadinessQuestion(employeeId, gap, words);
      setResult(done);
      if (done.ok) {
        setWriting(false);
        setAnswer('');
        router.refresh();
      }
    });

  return (
    <li
      className={styles.readinessItem}
      data-testid={`readiness-gap-${index}`}
      data-coverage={gap.coverage}
    >
      <span className={styles.readinessLine}>
        <UserText>{gap.question}</UserText>
        <span className={styles.state}>{t(`coverage.${gap.coverage}`)}</span>
        {writing || result?.ok ? null : (
          <button
            type="button"
            className={styles.linkButton}
            aria-label={t('answer.for', { question: gap.question })}
            data-testid={`readiness-answer-start-${index}`}
            onClick={() => {
              setResult(null);
              setWriting(true);
            }}
          >
            {t('answer.start')}
          </button>
        )}
      </span>
      {gap.reason.trim() !== '' ? (
        <span className={styles.note}>
          <UserText>{gap.reason}</UserText>
        </span>
      ) : null}
      {writing ? (
        <span className={styles.readinessAnswer}>
          <label htmlFor={id} className={styles.note}>
            {t('answer.label')}
          </label>
          <textarea
            id={id}
            className={styles.readinessAnswerText}
            value={answer}
            rows={3}
            maxLength={MAX_READINESS_ANSWER}
            dir={typedDir(answer)}
            placeholder={t('answer.placeholder')}
            data-testid={`readiness-answer-text-${index}`}
            onChange={(e) => setAnswer(e.target.value)}
          />
          <span className={styles.readinessAnswerActions}>
            <button
              type="button"
              className={styles.add}
              disabled={saving || words === ''}
              data-testid={`readiness-answer-save-${index}`}
              onClick={add}
            >
              {saving ? t('answer.saving') : t('answer.save')}
            </button>
            <button
              type="button"
              className={styles.linkButton}
              disabled={saving}
              data-testid={`readiness-answer-cancel-${index}`}
              onClick={() => {
                setWriting(false);
                setResult(null);
              }}
            >
              {t('answer.cancel')}
            </button>
          </span>
        </span>
      ) : null}
      {result?.ok ? (
        <span className={styles.note} role="status" data-testid={`readiness-answer-added-${index}`}>
          {t('answer.added')}
        </span>
      ) : result ? (
        <span
          className={styles.problem}
          role="alert"
          data-testid={`readiness-answer-problem-${index}`}
        >
          {t(`answer.problem.${result.reason}`, { max: MAX_READINESS_ANSWER })}
        </span>
      ) : null}
    </li>
  );
}
