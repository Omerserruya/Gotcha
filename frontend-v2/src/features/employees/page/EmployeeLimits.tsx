'use client';

import { Plus, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { typedDir } from '@/lib/typed-dir';

import { limitsProblem, MAX_LIMIT_LENGTH, MAX_LIMITS } from './profile-plan';
import styles from './EmployeePage.module.css';

/**
 * ★★ E4 (Omer, 2026-10-14): "Limits" - the employee's own rules, in the
 * owner's words: added, reworded, removed, and saved with the rest of the
 * Profile tab (`customGuardrails`, the whole list - see `profile-plan.ts`).
 * Drawn as "Handoff to a person" is, its neighbour on the tab.
 *
 * Unread rules are said and cannot be edited: Save replaces the list, and
 * would erase rules nobody saw. A rule the server refused is marked by its
 * place (`refusedAt`, GUARDRAILS_INVALID's `index`).
 */
export function EmployeeLimits({
  limits,
  onChange,
  refusedAt = null,
}: {
  /** `null` when unread. */
  readonly limits: readonly string[] | null;
  readonly onChange: (limits: readonly string[]) => void;
  readonly refusedAt?: number | null;
}) {
  const t = useTranslations('employees.profile.limits');
  /*
    A rule just added is empty by design: "needs words" is said once a rule
    has been left, never as it appears (dev, 2026-10-14). Save stays disabled
    meanwhile. Too long and too many are said at once - typing made them.
  */
  const [left, setLeft] = useState(false);
  if (limits === null) {
    return (
      <p className={styles.quiet} data-testid="profile-limits-unread">
        {t('unread')}
      </p>
    );
  }
  const found = limitsProblem(limits);
  const problem = found === 'empty' && !left ? null : found;

  return (
    <>
      {limits.length === 0 ? (
        <p className={styles.quiet} data-testid="profile-limits-none">
          {t('none')}
        </p>
      ) : (
        <ol className={styles.rules} data-testid="profile-limits-list">
          {limits.map((rule, i) => (
            <li key={i} className={styles.rule} data-testid={`profile-limit-${i}`}>
              <input
                type="text"
                className={styles.ruleLabel}
                value={rule}
                maxLength={MAX_LIMIT_LENGTH}
                dir={typedDir(rule)}
                placeholder={t('placeholder')}
                aria-label={t('labelFor', { n: i + 1 })}
                aria-invalid={
                  (left && rule.trim() === '') ||
                  rule.trim().length > MAX_LIMIT_LENGTH ||
                  refusedAt === i
                    ? true
                    : undefined
                }
                onBlur={() => setLeft(true)}
                data-testid={`profile-limit-${i}-text`}
                onChange={(e) => onChange(limits.map((r, j) => (j === i ? e.target.value : r)))}
              />
              <button
                type="button"
                className={styles.ruleRemove}
                aria-label={t('removeFor', { n: i + 1 })}
                data-testid={`profile-limit-${i}-remove`}
                onClick={() => onChange(limits.filter((_, j) => j !== i))}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ol>
      )}
      {problem ? (
        <p className={styles.problem} role="status" data-testid="profile-limits-problem">
          {t(`problem.${problem}`, { max: problem === 'tooMany' ? MAX_LIMITS : MAX_LIMIT_LENGTH })}
        </p>
      ) : null}
      {limits.length >= MAX_LIMITS ? (
        <p className={styles.quiet} data-testid="profile-limits-full">
          {t('full', { max: MAX_LIMITS })}
        </p>
      ) : (
        <button
          type="button"
          className={styles.add}
          data-testid="profile-limit-add"
          onClick={() => onChange([...limits, ''])}
        >
          <Plus size={14} aria-hidden="true" />
          {t('add')}
        </button>
      )}
    </>
  );
}
