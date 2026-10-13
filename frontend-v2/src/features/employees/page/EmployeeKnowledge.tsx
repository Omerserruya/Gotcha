'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition, type ReactNode } from 'react';

import { humaniseCode } from '@/api/contracts/capabilities';
import tab from '@/features/skills/EmployeeSkills.module.css';
import { Link, useRouter } from '@/i18n/navigation';

import { saveEmployeeEdits } from '../actions';
import hire from '../hire/Hire.module.css';
import {
  knowledgePatch,
  reachedByScope,
  reachOf,
  type EmployeeKnowledgeSource,
} from './knowledge-plan';
import styles from './EmployeePage.module.css';

/**
 * The employee page's Knowledge tab: every knowledge base in the workspace,
 * and whether this employee reads it - and why. A source its scope does not
 * already reach has a switch: connected to this employee, or not. One Save
 * sends the whole list (`knowledgeBaseIds` replaces it).
 *
 * Without the workspace's list (a failed read), what is connected to it, as
 * the employee read says, and no switches.
 */
export function EmployeeKnowledge({
  employee,
  connected,
  sources,
  head,
  tabs,
}: {
  readonly employee: {
    readonly id: string;
    readonly name: string;
    readonly departmentId: string | null;
  };
  /** What is attached to it, as the employee read says. */
  readonly connected: readonly { readonly id: string; readonly name: string }[];
  /** Every knowledge base in the workspace; `null` when the read failed. */
  readonly sources: readonly EmployeeKnowledgeSource[] | null;
  readonly head: ReactNode;
  readonly tabs: ReactNode;
}) {
  const t = useTranslations('employees.knowsTab');
  const router = useRouter();
  const [baseline, setBaseline] = useState<ReadonlySet<string>>(
    () => new Set(connected.map((c) => c.id)),
  );
  const [attached, setAttached] = useState<ReadonlySet<string>>(baseline);
  const [said, setSaid] = useState<'saved' | 'failed' | 'forbidden' | null>(null);
  const [saving, startSave] = useTransition();
  const changed = attached.size !== baseline.size || [...attached].some((id) => !baseline.has(id));

  const save = () =>
    startSave(async () => {
      setSaid(null);
      const result = await saveEmployeeEdits(employee.id, knowledgePatch(attached));
      if (!result.ok) {
        setSaid(result.reason === 'forbidden' ? 'forbidden' : 'failed');
        return;
      }
      setBaseline(attached);
      setSaid('saved');
      router.refresh();
    });

  const toggle = (id: string, on: boolean) => {
    const next = new Set(attached);
    if (on) next.add(id);
    else next.delete(id);
    setAttached(next);
  };

  return (
    <div className={tab.tab}>
      <header className={tab.head}>
        {head}
        {said ? (
          <p className={tab.said} role="status" data-said={said} data-testid="knows-said">
            {t(`said.${said}`)}
          </p>
        ) : null}
        <button
          type="button"
          className={tab.save}
          disabled={!changed || saving}
          onClick={save}
          data-testid="knows-save"
        >
          {saving ? t('saving') : t('save')}
        </button>
      </header>
      {tabs}

      <div className={styles.scroll}>
        <div className={styles.list} data-testid="employee-knowledge">
          <section className={styles.section}>
            <h2 className={styles.title}>{t('title')}</h2>
            <p className={styles.quiet}>{t('lead', { name: employee.name })}</p>
            {sources === null ? (
              <>
                <p className={styles.problem} data-testid="knows-unread">
                  {t('unread')}
                </p>
                {connected.length === 0 ? (
                  <p className={styles.quiet}>{t('connectedNone')}</p>
                ) : (
                  <ul className={styles.rows} data-testid="knows-connected">
                    {connected.map((source) => (
                      <li key={source.id} className={styles.row}>
                        <span className={styles.rowName}>
                          <bdi dir="auto">{source.name || humaniseCode(source.id)}</bdi>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : sources.length === 0 ? (
              <p className={styles.quiet} data-testid="knows-none">
                {t('none')}
              </p>
            ) : (
              <ul className={styles.rows} data-testid="knows-rows">
                {sources.map((source) => {
                  const reach = reachOf(source, employee, attached);
                  const name = source.name || humaniseCode(source.id);
                  return (
                    <li
                      key={source.id}
                      className={styles.row}
                      data-testid={`knows-${source.id}`}
                      data-reach={reach}
                    >
                      <span className={styles.rowName}>
                        <bdi dir="auto">{name}</bdi>
                        <span className={styles.state} data-testid={`knows-${source.id}-reach`}>
                          {t(`reach.${reach}`)}
                        </span>
                      </span>
                      {reachedByScope(source, employee) ? null : (
                        <input
                          type="checkbox"
                          role="switch"
                          className={hire.switch}
                          checked={attached.has(source.id)}
                          aria-label={t('connect', { source: name })}
                          data-testid={`knows-${source.id}-on`}
                          onChange={(e) => toggle(source.id, e.target.checked)}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            <Link href="/studio/knowledge" className={styles.link} data-testid="knows-manage">
              {t('manage')}
            </Link>
          </section>
        </div>
      </div>
    </div>
  );
}
