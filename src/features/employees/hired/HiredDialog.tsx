import { Check } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';

import { handoverRules, type Employee } from '@/api/contracts/employees';
import { UserText } from '@/design-system/primitives/text/UserText';
import { Link } from '@/i18n/navigation';

import hire from '../hire/Hire.module.css';
import { PauseEmployee } from '../PauseEmployee';
import styles from './Hired.module.css';

/** Where each kind of readiness recommendation is resolved. */
const RESOLVE_AT: Record<string, '/studio/knowledge' | '/settings/systems'> = {
  add_knowledge: '/studio/knowledge',
  add_faq: '/studio/knowledge',
  add_business_data: '/studio/knowledge',
  connect_tool: '/settings/systems',
};

/**
 * 07e, measured: "Hired" - a 720 dialog over Studio, 120 from the top.
 *
 * It follows a hire, which is not live, so it is reached at `?hired=<id>`
 * for an employee that exists, and says what is true of it:
 *
 *   the head            its status and when it was created - nothing
 *                       records who hired it
 *   It answers …        its status and its channels; Change opens 07f
 *   Handover rules      the rules that are on; Adjust opens 07f
 *   The readiness card  the last readiness test's first recommendation,
 *                       persisted by the platform - never a fresh run
 *
 * ── DRAWN, AND WHY ──
 *   Drafts first        no watch-only mode: `ACTIVE | DRAFT | PAUSED`
 *   About N a day       nothing estimates what will reach a person
 *   We will come back   nothing schedules a week-one review
 */
export async function HiredDialog({
  employee,
  channels,
}: {
  readonly employee: Employee;
  /** Where it answers, named. */
  readonly channels: readonly string[];
}) {
  const t = await getTranslations('employees.hired');
  const format = await getFormatter();
  const back = { pathname: '/studio/employees', query: { employee: employee.id } } as const;
  const edit = { pathname: '/studio/employees', query: { employee: employee.id, edit: '1' } };
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
                <span className={styles.rowSub}>-</span>
              </div>
              <span className={styles.pill} title={t('watchNone')}>
                -
              </span>
            </li>
            <li className={styles.row} data-testid="hired-answers">
              <div className={styles.rowText}>
                <span className={styles.rowTitle}>{t(`answers.${employee.status}`)}</span>
                <span className={styles.rowSub}>
                  {channels.length > 0 ? channels.join(' · ') : '-'}
                </span>
              </div>
              <Link href={edit} className={styles.small} scroll={false} data-testid="hired-change">
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
              <Link href={edit} className={styles.small} scroll={false} data-testid="hired-adjust">
                {t('adjust')}
              </Link>
            </li>
          </ul>

          {/* Amber only for a real finding; no test, or no gap, is quiet. */}
          {first ? (
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
              <p className={styles.quietTitle}>{report ? t('noGaps') : t('notTested')}</p>
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
