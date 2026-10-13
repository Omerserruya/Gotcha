'use client';

import { Plus, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { typedDir } from '@/lib/typed-dir';

import { MAX_RULE_LABEL, MAX_RULES, newRule, rulesProblem, type DraftRule } from './profile-plan';
import styles from './EmployeePage.module.css';

/**
 * "Handoff to a person": the conditions, each with its words and an on
 * switch - added, reworded, switched, removed. ONE editor for the employee
 * page's Profile tab and the hire flow's Limits (Omer, 2026-10-13, H3), so
 * the two can never drift: the same rule model (`profile-plan.ts`), the same
 * bounds (`MAX_RULES`, `MAX_RULE_LABEL` - the route's), the same words.
 *
 * `id` prefixes each test id: `profile` on the page, `hire` in the flow.
 */
export function HandoverRules({
  rules,
  onChange,
  id,
}: {
  readonly rules: readonly DraftRule[];
  readonly onChange: (rules: readonly DraftRule[]) => void;
  readonly id: string;
}) {
  const t = useTranslations('employees.profile.handover');
  const problem = rulesProblem(rules);
  const setRule = (i: number, patch: Partial<DraftRule>) =>
    onChange(rules.map((rule, j) => (j === i ? { ...rule, ...patch } : rule)));

  return (
    <>
      {rules.length === 0 ? (
        <p className={styles.quiet} data-testid={`${id}-rules-none`}>
          {t('none')}
        </p>
      ) : (
        <ol className={styles.rules} data-testid={`${id}-rules`}>
          {rules.map((rule, i) => (
            <li key={i} className={styles.rule} data-testid={`${id}-rule-${i}`}>
              <input
                type="checkbox"
                className={styles.ruleOn}
                checked={rule.enabled}
                aria-label={t('onFor', { n: i + 1 })}
                data-testid={`${id}-rule-${i}-on`}
                onChange={(e) => setRule(i, { enabled: e.target.checked })}
              />
              <input
                type="text"
                className={styles.ruleLabel}
                value={rule.label}
                maxLength={MAX_RULE_LABEL}
                dir={typedDir(rule.label)}
                placeholder={t('placeholder')}
                aria-label={t('labelFor', { n: i + 1 })}
                aria-invalid={rule.label.trim() === '' ? true : undefined}
                data-testid={`${id}-rule-${i}-label`}
                onChange={(e) => setRule(i, { label: e.target.value })}
              />
              <button
                type="button"
                className={styles.ruleRemove}
                aria-label={t('removeFor', { n: i + 1 })}
                data-testid={`${id}-rule-${i}-remove`}
                onClick={() => onChange(rules.filter((_, j) => j !== i))}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ol>
      )}
      {problem === 'empty' ? (
        <p className={styles.problem} role="status" data-testid={`${id}-rules-problem`}>
          {t('empty')}
        </p>
      ) : null}
      {rules.length >= MAX_RULES ? (
        <p className={styles.quiet} data-testid={`${id}-rules-full`}>
          {t('full', { max: MAX_RULES })}
        </p>
      ) : (
        <button
          type="button"
          className={styles.add}
          data-testid={`${id}-rule-add`}
          onClick={() => onChange([...rules, newRule()])}
        >
          <Plus size={14} aria-hidden="true" />
          {t('add')}
        </button>
      )}
    </>
  );
}
