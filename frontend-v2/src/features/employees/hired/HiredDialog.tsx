import { Check } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';

import { handoverRules, type Employee } from '@/api/contracts/employees';
import { UserText } from '@/design-system/primitives/text/UserText';
import { Link } from '@/i18n/navigation';

import hire from '../hire/Hire.module.css';
import { PauseEmployee } from '../PauseEmployee';
import { RESOLVE_AT, type ReadinessRun } from '../page/readiness';
import { ReadinessPoll } from '../page/ReadinessPoll';
import { automationsLink, WhoAnswers, type ReachItem } from '../WhoAnswers';
import styles from './Hired.module.css';

/**
 * 07e, measured: "Hired" - a 720 dialog over Studio, 120 from the top.
 *
 * It follows a hire (H5: the hire sheet opens it on success) at `?hired=<id>`
 * for an employee that exists, and says what is true of it:
 *
 *   the head            its status and when it was created - nothing
 *                       records who hired it
 *   It answers …        its status, and where that is decided; Change opens
 *                       the employee page's Channels tab
 *   Handover rules      the rules that are on; Adjust opens its Profile tab
 *   The readiness card  the last readiness test's first recommendation,
 *                       persisted by the platform - never a fresh run.
 *                       07e opens as the hire completes, while the test
 *                       that follows it runs: "Checking readiness…" while
 *                       it is stored as running, read again every few
 *                       seconds; a failed one says why (H7's words)
 *
 * ── DRAWN, AND WHY ──
 *   Drafts first        no watch-only mode: `ACTIVE | DRAFT | PAUSED`
 *   About N a day       nothing estimates what will reach a person
 *   We will come back   nothing schedules a week-one review
 */
export async function HiredDialog({
  employee,
  reach = null,
  run = { state: 'idle' },
}: {
  readonly employee: Employee;
  /** Where it answers, by the playbook; `null` when unread. */
  readonly reach?: readonly ReachItem[] | null;
  /** The readiness run, by its stored status (load-readiness-run.ts). */
  readonly run?: ReadinessRun;
}) {
  const t = await getTranslations('employees.hired');
  const te = await getTranslations('employees');
  const format = await getFormatter();
  const back = { pathname: '/studio/employees', query: { employee: employee.id } } as const;
  // Changing it is the employee's page - never a sheet: where it answers is
  // the Channels tab, its handover rules the Profile tab.
  const edit = `/studio/employees/${employee.id}`;
  const channels = `/studio/employees/${employee.id}/channels`;
  const rules = handoverRules(employee);
  const report = employee.readinessReport;
  const first = report?.recommendations.find((r) => r.title.trim() !== '') ?? null;
  const resolveAt = first ? RESOLVE_AT[first.type] : undefined;
  const created = employee.createdAt ? new Date(employee.createdAt) : null;

  return (
    <div className={hire.layer} data-testid="hired-dialog">
      <Link
        href={back}
        className={hire.scrim}
        aria-label={t('close')}
        tabIndex={-1}
        scroll={false}
      />
      <section
        className={styles.dialog}
        aria-label={t(`title.${employee.status}`, { name: employee.name })}
      >
        <header className={styles.head}>
          <span className={styles.tile} data-status={employee.status}>
            {employee.status === 'ACTIVE' ? <Check size={17} aria-hidden="true" /> : null}
          </span>
          <div>
            <h2 className={styles.title}>
              {t(`title.${employee.status}`, { name: employee.name })}
            </h2>
            <p className={styles.line} data-testid="hired-line">
              {created && !Number.isNaN(created.getTime())
                ? t('created', {
                    when: format.dateTime(created, {
                      day: 'numeric',
                      month: 'long',
                      hour: '2-digit',
                      minute: '2-digit',
                      hour12: false,
                    }),
                  })
                : '-'}
            </p>
          </div>
        </header>

        <div className={styles.body}>
          <ul className={styles.rows}>
            <li className={styles.row} data-testid="hired-watch">
              <div className={styles.rowText}>
                <span className={styles.rowTitle}>{t('watch')}</span>
                {/*
                  No watch-only mode exists, so the reason is the row's line,
                  said - never a "-" pill at its end that looks like an action
                  (dev, 2026-10-13).
                */}
                <span className={styles.rowSub} data-testid="hired-watch-none">
                  {t('watchNone')}
                </span>
              </div>
            </li>
            <li className={styles.row} data-testid="hired-answers">
              <div className={styles.rowText}>
                <span className={styles.rowTitle}>{t(`answers.${employee.status}`)}</span>
                <WhoAnswers
                  className={styles.rowSub}
                  text={te.rich('whoAnswers', { automations: automationsLink })}
                  reach={reach}
                  where={te.rich('reach.where', { automations: automationsLink })}
                  nowhere={te.rich('reach.nowhere', { automations: automationsLink })}
                />
              </div>
              <Link href={channels} className={styles.small} data-testid="hired-change">
                {t('change')}
              </Link>
            </li>
            <li className={styles.row} data-testid="hired-reach">
              <div className={styles.rowText}>
                <span className={styles.rowTitle} title={t('reachNone')}>
                  {rules.length > 0 ? t('rules', { count: rules.length }) : t('noRules')}
                </span>
                <span className={styles.rowSub}>
                  {rules.length > 0 ? <UserText>{rules.join(' · ')}</UserText> : '-'}
                </span>
              </div>
              <Link href={edit} className={styles.small} data-testid="hired-adjust">
                {t('adjust')}
              </Link>
            </li>
          </ul>

          {/* Amber only for a real finding; no test, or no gap, is quiet. */}
          {run.state === 'running' ? (
            <div className={styles.quiet} role="status" data-testid="hired-checking">
              <p className={styles.quietTitle}>{te('readiness.checking')}</p>
              <ReadinessPoll />
            </div>
          ) : first ? (
            <div className={styles.gap} data-testid="hired-gap">
              <span className={styles.gapDot} aria-hidden="true" />
              <div className={styles.gapText}>
                <p
                  className={styles.gapTitle}
                  title={
                    report?.generatedAt
                      ? t('testedOn', {
                          when: format.dateTime(new Date(report.generatedAt), {
                            dateStyle: 'medium',
                          }),
                        })
                      : undefined
                  }
                >
                  {t('gaps', { count: report?.recommendations.length ?? 1 })}
                </p>
                <p className={styles.gapBody}>
                  <UserText>
                    {first.detail.trim() ? `${first.title} - ${first.detail}` : first.title}
                  </UserText>
                </p>
              </div>
              {resolveAt ? (
                <Link href={resolveAt} className={styles.resolve} data-testid="hired-resolve">
                  {t('resolve')}
                </Link>
              ) : null}
            </div>
          ) : (
            <div className={styles.quiet} data-testid="hired-no-gap">
              <p className={styles.quietTitle}>
                {run.state === 'failed'
                  ? te(`readiness.failed.${run.failure}`)
                  : report
                    ? t('noGaps')
                    : t('notTested')}
              </p>
            </div>
          )}

          <div className={styles.foot}>
            <Link href={back} className={styles.primary} scroll={false} data-testid="hired-see">
              {t('see')}
            </Link>
            {employee.status !== 'DRAFT' ? (
              <PauseEmployee
                id={employee.id}
                name={employee.name}
                openConversations={employee.openConversations}
                paused={employee.status === 'PAUSED'}
                large
              />
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
