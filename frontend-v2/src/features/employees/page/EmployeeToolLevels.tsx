'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { TOOL_LEVELS, type EmployeeTool, type ToolLevel } from '@/api/contracts/employees';
import { useRouter } from '@/i18n/navigation';

import styles from './EmployeePage.module.css';
import { setEmployeeToolLevel, type ToolLevelResult } from './tool-level-actions';

/** The page's stance colours, by level. */
const STANCE_OF: Readonly<Record<ToolLevel, string>> = {
  execute: 'on_its_own',
  ask: 'ask_first',
  never: 'never',
};

/** One action as the list draws it: the server's levels, and its name in words. */
export type ToolLevelRow = Pick<
  EmployeeTool,
  'toolName' | 'workspaceLevel' | 'ownLevel' | 'employeeLevel' | 'allowedLevels'
> & { readonly label: string };

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ WHAT THIS EMPLOYEE MAY DO, PER ACTION (Omer, 2026-10-13, E5)
 * ════════════════════════════════════════════════════════════════════════════
 * "What it may do on its own" and "when it hands over" were read-only. They
 * are one editable list now, as Integrations draws it: every action, and
 * לבצע / לשאול אותי / אף פעם for THIS employee.
 *
 * ★ NEVER LOOSER THAN THE WORKSPACE. The server sends the levels this
 *   employee may be set to (`allowedLevels`); the rest are drawn and
 *   greyed, with the workspace's own level as the reason, and the server
 *   refuses them anyway (422). A level saves as it is pressed; one equal to
 *   the workspace's is stored as "like the workspace".
 */
export function EmployeeToolLevels({
  employeeId,
  rows,
}: {
  readonly employeeId: string;
  /** `null` when the read failed. */
  readonly rows: readonly ToolLevelRow[] | null;
}) {
  const t = useTranslations('employees.page.levels');
  if (rows === null) {
    return (
      <p className={styles.quiet} data-testid="levels-unavailable">
        {t('unavailable')}
      </p>
    );
  }
  if (rows.length === 0) {
    return <p className={styles.quiet}>{t('none')}</p>;
  }
  return (
    <>
      <p className={styles.note} data-testid="levels-rule">
        {t('rule')}
      </p>
      <ul className={styles.rows} data-testid="levels-rows">
        {rows.map((row) => (
          <LevelRow key={row.toolName} employeeId={employeeId} row={row} />
        ))}
      </ul>
    </>
  );
}

function LevelRow({
  employeeId,
  row,
}: {
  readonly employeeId: string;
  readonly row: ToolLevelRow;
}) {
  const t = useTranslations('employees.page.levels');
  const router = useRouter();
  const [level, setLevel] = useState<ToolLevel>(row.employeeLevel);
  const [own, setOwn] = useState(row.ownLevel !== null && row.ownLevel !== undefined);
  const [result, setResult] = useState<ToolLevelResult | null>(null);
  const [isPending, startTransition] = useTransition();

  const write = (next: ToolLevel | null) => {
    const was = { level, own };
    const target = next ?? row.workspaceLevel;
    setResult(null);
    setLevel(target);
    setOwn(next !== null && next !== row.workspaceLevel);
    startTransition(async () => {
      const done = await setEmployeeToolLevel(
        employeeId,
        row.toolName,
        next === row.workspaceLevel ? null : next,
      );
      setResult(done);
      if (done.ok) router.refresh();
      else {
        setLevel(was.level);
        setOwn(was.own);
      }
    });
  };

  return (
    <li className={`${styles.row} ${styles.levelRow}`} data-testid={`level-${row.toolName}`}>
      <span className={styles.rowName}>
        <bdi dir="auto">{row.label}</bdi>
        <span className={styles.state} data-testid={`level-source-${row.toolName}`}>
          {own ? t('own') : t('likeWorkspace')}
        </span>
      </span>
      <span className={styles.stances} role="group" aria-label={row.label}>
        {TOOL_LEVELS.map((option) => {
          const allowed = row.allowedLevels.includes(option);
          return (
            <button
              key={option}
              type="button"
              className={`${styles.stance} ${styles.stanceButton}`}
              data-stance={STANCE_OF[option]}
              data-current={level === option ? 'yes' : 'no'}
              aria-pressed={level === option}
              aria-disabled={allowed ? undefined : 'true'}
              title={
                allowed
                  ? undefined
                  : t('looserThanWorkspace', { level: t(`level.${row.workspaceLevel}`) })
              }
              disabled={isPending}
              data-testid={`level-${row.toolName}-${option}`}
              onClick={() => {
                if (!allowed || option === level) return;
                write(option);
              }}
            >
              {t(`level.${option}`)}
            </button>
          );
        })}
      </span>
      {own ? (
        <button
          type="button"
          className={styles.linkButton}
          disabled={isPending}
          data-testid={`level-reset-${row.toolName}`}
          onClick={() => write(null)}
        >
          {t('reset')}
        </button>
      ) : null}
      {result && !result.ok ? (
        <p className={styles.problem} role="alert" data-testid={`level-problem-${row.toolName}`}>
          {t(`problem.${result.reason}`)}
        </p>
      ) : null}
    </li>
  );
}
