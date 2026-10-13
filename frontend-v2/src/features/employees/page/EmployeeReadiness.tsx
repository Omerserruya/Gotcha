'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState, useTransition } from 'react';

import type { Employee } from '@/api/contracts/employees';
import { UserText } from '@/design-system/primitives/text/UserText';
import { Link, useRouter } from '@/i18n/navigation';

import { rerunReadiness, type ReadinessRunResult } from './readiness-actions';
import { readinessGaps, RESOLVE_AT, type ReadinessRun } from './readiness';
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
            {report.generatedAt ? (
              <span className={styles.edited}>
                {t('tested', { when: format.relativeTime(new Date(report.generatedAt)) })}
              </span>
            ) : null}
          </p>

          <div className={styles.block} data-testid="readiness-gaps">
            <h3 className={styles.subtitle}>{t('gaps')}</h3>
            {gaps.length === 0 ? (
              <p className={styles.quiet} data-testid="readiness-no-gaps">
                {t('noGaps')}
              </p>
            ) : (
              <ul className={styles.rows}>
                {gaps.map((gap, i) => (
                  <li
                    key={i}
                    className={styles.readinessItem}
                    data-testid={`readiness-gap-${i}`}
                    data-coverage={gap.coverage}
                  >
                    <span className={styles.readinessLine}>
                      <UserText>{gap.question}</UserText>
                      <span className={styles.state}>{t(`coverage.${gap.coverage}`)}</span>
                    </span>
                    {gap.reason.trim() !== '' ? (
                      <span className={styles.note}>
                        <UserText>{gap.reason}</UserText>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

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
