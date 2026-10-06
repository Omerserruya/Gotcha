'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState, useTransition } from 'react';

import type { AutomationRun, RunStep } from '@/api/contracts/automations';
import { Link } from '@/i18n/navigation';

import { readRun, readRuns } from './automation-actions';
import styles from './Builder.module.css';

const BRANCHES = [
  'next',
  'true',
  'false',
  'open',
  'closed',
  'new',
  'returning',
  'vip',
  'a',
  'b',
  'reply',
  'timeout',
  'other',
  'yes',
  'no',
] as const;

/**
 * 09d's Run log: this automation's runs, newest first, a page at a time;
 * one opened shows its steps. Read when opened - until something has run,
 * it says "No runs yet". A run in a conversation this person may not see is
 * not listed (the route hides it).
 */
export function RunLog({ automationId }: { readonly automationId: string }) {
  const t = useTranslations('automations');
  const format = useFormatter();
  const [page, setPage] = useState<
    | { readonly runs: readonly AutomationRun[]; readonly nextCursor: string | null }
    | null
    | 'reading'
  >('reading');
  const [open, setOpen] = useState<
    (AutomationRun & { readonly steps: readonly RunStep[] }) | null | 'reading' | 'unread'
  >(null);
  const [, start] = useTransition();

  useEffect(() => {
    let live = true;
    void readRuns(automationId, null).then((read) => {
      if (live) setPage(read);
    });
    return () => {
      live = false;
    };
  }, [automationId]);

  const more = (cursor: string) =>
    start(async () => {
      const read = await readRuns(automationId, cursor);
      if (read)
        setPage((now) =>
          now && typeof now === 'object'
            ? { runs: [...now.runs, ...read.runs], nextCursor: read.nextCursor }
            : read,
        );
    });

  /** A branch in words: a known one by name, a button as "a button", anything else as sent. */
  const branchWords = (branch: string) =>
    branch.startsWith('btn:')
      ? t('branches.button')
      : (BRANCHES as readonly string[]).includes(branch)
        ? t(`branches.${branch}` as 'branches.next')
        : branch;

  const when = (iso: string | null) =>
    iso
      ? format.dateTime(new Date(iso), {
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        })
      : '';

  return (
    <section className={styles.runLog} aria-labelledby="run-log-title" data-testid="run-log">
      <h2 className={styles.inspectorTitle} id="run-log-title">
        {t('builder.runLog')}
      </h2>
      {page === 'reading' ? (
        <p className={styles.quiet}>{t('runLog.reading')}</p>
      ) : page === null ? (
        <p className={styles.quiet}>{t('runLog.unread')}</p>
      ) : page.runs.length === 0 ? (
        <p className={styles.quiet} data-testid="run-log-empty">
          {t('noRuns')}
        </p>
      ) : (
        <ol className={styles.runs}>
          {page.runs.map((run) => (
            <li key={run.id}>
              <button
                type="button"
                className={styles.run}
                aria-expanded={open !== null && typeof open === 'object' && open.id === run.id}
                onClick={() => {
                  setOpen('reading');
                  start(async () => setOpen((await readRun(run.id)) ?? 'unread'));
                }}
                data-testid={`run-${run.id}`}
              >
                <span className={styles.runStatus} data-status={run.status}>
                  {t(`runLog.status.${run.status}`)}
                </span>
                <span className={styles.quiet}>{when(run.startedAt)}</span>
                {run.contact?.name ? (
                  <span className={styles.runWho}>
                    <bdi dir="auto">{run.contact.name}</bdi>
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ol>
      )}
      {page && typeof page === 'object' && page.nextCursor ? (
        <button type="button" className={styles.textButton} onClick={() => more(page.nextCursor!)}>
          {t('runLog.more')}
        </button>
      ) : null}

      {open === 'reading' ? (
        <p className={styles.quiet}>{t('runLog.reading')}</p>
      ) : open === 'unread' ? (
        <p className={styles.quiet}>{t('runLog.runUnread')}</p>
      ) : open ? (
        <div className={styles.trace} data-testid="run-trace">
          {open.error ? <p className={styles.problem}>{open.error}</p> : null}
          <ol className={styles.steps}>
            {open.steps.map((step, i) => (
              <li
                key={`${step.nodeId}-${i}`}
                className={styles.traceStep}
                data-status={step.status}
              >
                <span>
                  {step.nodeType === 'automation_trigger'
                    ? t('groups.trigger')
                    : t(`nodes.${step.nodeType}` as 'nodes.wait')}
                </span>
                <span className={styles.quiet}>
                  {t(`runLog.stepStatus.${step.status}`)}
                  {step.branch ? ` · ${branchWords(step.branch)}` : ''}
                </span>
              </li>
            ))}
          </ol>
          {open.conversationId ? (
            <Link
              href={{ pathname: '/inbox', query: { c: open.conversationId } }}
              className={styles.textButton}
            >
              {t('runLog.openConversation')}
            </Link>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
