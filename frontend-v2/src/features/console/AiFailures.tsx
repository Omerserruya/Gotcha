import { getFormatter, getTranslations } from 'next-intl/server';

import { AI_FAILURE_HOURS, type AiFailures as AiFailuresData } from '@/api/contracts/ai-failures';
import { Button } from '@/design-system/primitives/button/Button';
import { UserText } from '@/design-system/primitives/text/UserText';

import { CopyId } from './CopyId';
import styles from './Console.module.css';
import type { AiFailureFilters } from './load-ai-failures';

/**
 * Console · "פעולות AI שנכשלו": the filters (in the address, so a view is a
 * link an operator can send), the failures grouped by tool and error, then
 * the latest 100 - each with its tenant's name and the conversation's id to
 * copy. Settings' table vocabulary, as the tenants list draws it.
 */
export async function AiFailures({
  data,
  filters,
  names,
}: {
  readonly data: AiFailuresData;
  readonly filters: AiFailureFilters;
  readonly names: ReadonlyMap<string, string>;
}) {
  const t = await getTranslations('console.aiFailures');
  const format = await getFormatter();
  const when = (iso: string | null) => {
    const date = iso ? new Date(iso) : null;
    return date && !Number.isNaN(date.getTime())
      ? format.dateTime(date, { dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' })
      : '-';
  };
  const tenants = [...names.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const tools = [
    ...new Set([...data.groups.map((g) => g.tool), filters.tool].filter(Boolean)),
  ].sort();
  const errorOf = (code: string | null) => code ?? t('noCode');

  return (
    <>
      <form method="get" className={styles.controlRow} data-testid="ai-failures-filters">
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('filters.hours')}</span>
          <select name="hours" defaultValue={String(filters.hours)} className={styles.select}>
            {AI_FAILURE_HOURS.map((h) => (
              <option key={h} value={h}>
                {t('filters.hoursOption', { hours: h })}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('filters.tenant')}</span>
          <select name="tenantId" defaultValue={filters.tenantId} className={styles.select}>
            <option value="">{t('filters.all')}</option>
            {filters.tenantId && !names.has(filters.tenantId) ? (
              <option value={filters.tenantId}>{filters.tenantId}</option>
            ) : null}
            {tenants.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('filters.tool')}</span>
          <select name="tool" defaultValue={filters.tool} className={styles.select}>
            <option value="">{t('filters.all')}</option>
            {tools.map((tool) => (
              <option key={tool} value={tool}>
                {tool}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="secondary" size="sm">
          {t('filters.submit')}
        </Button>
      </form>

      {data.total === 0 ? (
        <p className={styles.quiet} data-testid="ai-failures-none">
          {t('none', { hours: data.hours })}
        </p>
      ) : (
        <>
          <p className={styles.quiet} data-testid="ai-failures-total">
            {t('total', { count: data.total, hours: data.hours })}
          </p>
          <div className={styles.table} role="table" aria-label={t('groups.title')}>
            <div className={styles.head} role="row">
              <span className={styles.colName} role="columnheader">
                {t('groups.tool')}
              </span>
              <span className={styles.colBadge} role="columnheader">
                {t('groups.error')}
              </span>
              <span className={styles.colCount} role="columnheader">
                {t('groups.count')}
              </span>
              <span className={styles.colCount} role="columnheader">
                {t('groups.tenants')}
              </span>
              <span className={styles.colBadge} role="columnheader">
                {t('groups.lastAt')}
              </span>
            </div>
            {data.groups.map((group) => (
              <div
                key={`${group.tool}|${group.errorCode ?? ''}`}
                className={styles.row}
                role="row"
                data-testid={`ai-failure-group-${group.tool}-${group.errorCode ?? 'none'}`}
              >
                <span className={`${styles.colName} ${styles.slug}`} role="cell" dir="ltr">
                  {group.tool}
                </span>
                <span className={`${styles.colBadge} ${styles.slug}`} role="cell" dir="ltr">
                  {errorOf(group.errorCode)}
                </span>
                <span className={styles.colCount} role="cell">
                  {format.number(group.count)}
                </span>
                <span className={styles.colCount} role="cell">
                  {format.number(group.tenants)}
                </span>
                <span className={styles.colBadge} role="cell">
                  {when(group.lastAt)}
                </span>
              </div>
            ))}
          </div>

          <h3 className={styles.cardTitle}>{t('recent.title', { count: data.recent.length })}</h3>
          <div className={styles.table} role="table" aria-label={t('recent.label')}>
            <div className={styles.head} role="row">
              <span className={styles.colBadge} role="columnheader">
                {t('recent.at')}
              </span>
              <span className={styles.colName} role="columnheader">
                {t('recent.tenant')}
              </span>
              <span className={styles.colName} role="columnheader">
                {t('recent.what')}
              </span>
              <span className={styles.colCount} role="columnheader">
                {t('recent.ms')}
              </span>
              <span className={styles.colName} role="columnheader">
                {t('recent.conversation')}
              </span>
            </div>
            {data.recent.map((row) => {
              const name = row.tenantId ? names.get(row.tenantId) : undefined;
              return (
                <div
                  key={row.id}
                  className={styles.row}
                  role="row"
                  data-testid={`ai-failure-${row.id}`}
                >
                  <span className={styles.colBadge} role="cell">
                    {when(row.at)}
                  </span>
                  <span className={styles.colName} role="cell">
                    {name ? <UserText className={styles.name}>{name}</UserText> : null}
                    {row.tenantId ? (
                      <span className={styles.slug} dir="ltr">
                        {row.tenantId}
                      </span>
                    ) : (
                      '-'
                    )}
                  </span>
                  <span className={styles.colName} role="cell">
                    <span className={styles.slug} dir="ltr">
                      {row.tool} · {errorOf(row.errorCode)}
                    </span>
                    {row.argsSummary ? (
                      <span className={styles.slug} dir="ltr">
                        {row.argsSummary}
                      </span>
                    ) : null}
                  </span>
                  <span className={styles.colCount} role="cell">
                    {row.ms === null ? '-' : format.number(row.ms)}
                  </span>
                  <span className={styles.colName} role="cell">
                    {row.conversationId ? (
                      <CopyId
                        value={row.conversationId}
                        testid={`ai-failure-conversation-${row.id}`}
                      />
                    ) : (
                      '-'
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
