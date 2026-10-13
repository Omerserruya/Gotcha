'use client';

import { Plus, X } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useState, useTransition, type ReactNode } from 'react';

import { humaniseCode, type CapabilityStance } from '@/api/contracts/capabilities';
import {
  accessState,
  EMPLOYEE_TONES,
  type Employee,
  type IntegrationAccess,
} from '@/api/contracts/employees';
import { Dialog, DialogContent } from '@/design-system/primitives/overlay/Dialog';
import tab from '@/features/skills/EmployeeSkills.module.css';
import { useRouter } from '@/i18n/navigation';
import { typedDir } from '@/lib/typed-dir';

import { saveEmployeeEdits, type EmployeeEditResult } from '../actions';
import hire from '../hire/Hire.module.css';
import {
  changesIn,
  draftOf,
  editPatch,
  MAX_RULE_LABEL,
  MAX_RULES,
  newRule,
  rulesProblem,
  type DraftRule,
  type ProfileDraft,
} from './profile-plan';
import styles from './EmployeePage.module.css';

/** One action and where the business stands on it - the same for every employee. */
export type ProfileMayDo = {
  readonly toolName: string;
  readonly label: string;
  readonly stance: CapabilityStance;
};

const STANCES = ['on_its_own', 'ask_first', 'never'] as const;

/**
 * The employee page's Profile tab (Omer, 2026-10-13, E3/E6): every regular
 * setting as ONE list, top to bottom, and one Save for all of it.
 *
 *   Responsible for     `identity.responsibility`
 *   How it answers      tone; the language line (a rule, never a choice);
 *                       "Says it's AI when asked" as a real switch
 *   Limits              what it may do (the business's, read here) and the
 *                       business systems it may use (its own, switched here)
 *   Handoff to a person the conditions, added, reworded, switched, removed -
 *                       saved as the whole array
 *
 * Save asks first, naming what changes and that it reaches live customers
 * from the next reply - the runtime reads the employee on every reply, so
 * open conversations take it too. Then one PATCH.
 */
export function EmployeeProfile({
  employee,
  head,
  tabs,
  mayDo,
  access = null,
}: {
  readonly employee: Employee;
  /** The page's head (avatar, name, standing) - Save sits beside it. */
  readonly head: ReactNode;
  readonly tabs: ReactNode;
  /** The business's actions and its stance on each; `null` when the read failed. */
  readonly mayDo: readonly ProfileMayDo[] | null;
  /** The business systems it may use, and every one set up; `null` when unread. */
  readonly access?: IntegrationAccess | null;
}) {
  const t = useTranslations('employees.profile');
  const td = useTranslations('employees.detail');
  const format = useFormatter();
  const router = useRouter();
  const stored = access?.allowed ?? null;
  const [draft, setDraft] = useState<ProfileDraft>(() => draftOf(employee, stored));
  const set = (patch: Partial<ProfileDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const setRule = (i: number, patch: Partial<DraftRule>) =>
    set({ rules: draft.rules.map((rule, j) => (j === i ? { ...rule, ...patch } : rule)) });
  const changes = changesIn(employee, draft, stored);
  const problem = rulesProblem(draft.rules);
  const [confirming, setConfirming] = useState(false);
  const [refused, setRefused] = useState<
    Exclude<EmployeeEditResult, { ok: true }>['reason'] | null
  >(null);
  const [saved, setSaved] = useState(false);
  const [saving, startSave] = useTransition();

  const save = () =>
    startSave(async () => {
      setRefused(null);
      const result = await saveEmployeeEdits(employee.id, editPatch(employee, draft, stored));
      if (!result.ok) {
        setRefused(result.reason);
        return;
      }
      setConfirming(false);
      setSaved(true);
      // Read again: what is shown is what was stored.
      router.refresh();
    });

  const toneName = (tone: string) =>
    (EMPLOYEE_TONES as readonly string[]).includes(tone)
      ? td(`tone.${tone}` as 'tone.friendly')
      : humaniseCode(tone);
  // The stored tone stays offered, even one the builder no longer writes.
  const tones = [...new Set([...EMPLOYEE_TONES, ...(employee.tone ? [employee.tone] : [])])];

  return (
    <div className={tab.tab}>
      <header className={tab.head}>
        {head}
        {saved && changes.length === 0 ? (
          <p className={tab.said} role="status" data-testid="profile-saved">
            {t('saved')}
          </p>
        ) : (
          <p className={styles.changes} data-testid="profile-changes">
            {changes.length > 0 ? t('changes', { count: changes.length }) : t('noChanges')}
          </p>
        )}
        <button
          type="button"
          className={tab.save}
          disabled={changes.length === 0 || problem !== null || saving}
          onClick={() => {
            setRefused(null);
            setSaved(false);
            setConfirming(true);
          }}
          data-testid="profile-save"
        >
          {t('save')}
        </button>
      </header>
      {tabs}

      <div className={styles.scroll}>
        <div className={styles.list} data-testid="employee-profile">
          <p className={styles.applies} data-testid="profile-applies">
            {employee.openConversations > 0
              ? t('applyOpen', { count: employee.openConversations })
              : t('apply')}
            {employee.updatedAt ? (
              <span className={styles.edited}>
                {t('edited', { when: format.relativeTime(new Date(employee.updatedAt)) })}
              </span>
            ) : null}
          </p>

          <section className={styles.section} data-testid="profile-responsible">
            <h2 className={styles.title}>{t('responsible')}</h2>
            <textarea
              className={styles.field}
              rows={2}
              value={draft.responsibility}
              placeholder={t('responsiblePlaceholder')}
              aria-label={t('responsible')}
              dir={typedDir(draft.responsibility)}
              data-testid="profile-responsibility"
              onChange={(e) => set({ responsibility: e.target.value })}
            />
          </section>

          <section className={styles.section} data-testid="profile-how">
            <h2 className={styles.title}>{t('how')}</h2>
            <dl className={styles.pairs}>
              <div className={styles.pair}>
                <dt>{t('tone')}</dt>
                <dd>
                  <span className={hire.segmented} role="radiogroup" aria-label={t('tone')}>
                    {tones.map((tone) => (
                      <button
                        key={tone}
                        type="button"
                        role="radio"
                        aria-checked={draft.tone === tone}
                        className={hire.segment}
                        data-testid={`profile-tone-${tone}`}
                        onClick={() => set({ tone })}
                      >
                        {toneName(tone)}
                      </button>
                    ))}
                  </span>
                </dd>
              </div>
              {/* A rule, not a choice (Omer, 2026-10-13, E6): nothing to pick. */}
              <div className={styles.pair}>
                <dt>{t('language')}</dt>
                <dd className={styles.quiet} data-testid="profile-language">
                  {t('languageRule')}
                </dd>
              </div>
              <div className={styles.pair}>
                <dt id="profile-discloses-label">{t('disclose.title')}</dt>
                <dd className={styles.switchRow}>
                  <span className={styles.quiet} data-testid="profile-discloses-says">
                    {draft.disclosesAi ? t('disclose.on') : t('disclose.off')}
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    className={hire.switch}
                    checked={draft.disclosesAi}
                    aria-labelledby="profile-discloses-label"
                    data-testid="profile-discloses"
                    onChange={(e) => set({ disclosesAi: e.target.checked })}
                  />
                </dd>
              </div>
            </dl>
          </section>

          <section className={styles.section} data-testid="profile-limits">
            <h2 className={styles.title}>{t('limits.title')}</h2>

            {/*
              What it may do: the business's stance per action, the same for
              every employee - read here, set in Integrations. An employee's
              own level per action (`GET /:id/tools`, `PUT /:id/tool-levels/
              :toolName`, Backend a9fc1aca) is E5, not built yet: it replaces
              these read-only pills when it lands.
            */}
            <div className={styles.block} data-testid="profile-may-do">
              <h3 className={styles.subtitle}>{td('mayDo.title')}</h3>
              {mayDo === null ? (
                <p className={styles.quiet}>{td('mayDo.unavailable')}</p>
              ) : mayDo.length === 0 ? (
                <p className={styles.quiet}>{td('mayDo.none')}</p>
              ) : (
                <ul className={styles.rows} data-testid="profile-may-rows">
                  {mayDo.map((row) => (
                    <li key={row.toolName} className={styles.row}>
                      <span className={styles.rowName} title={row.label}>
                        {row.label}
                      </span>
                      <span className={styles.stances}>
                        {STANCES.map((stance) => (
                          <span
                            key={stance}
                            className={styles.stance}
                            data-stance={stance}
                            data-current={row.stance === stance ? 'yes' : 'no'}
                            data-testid={`profile-may-${row.toolName}-${stance}`}
                          >
                            {td(`mayDo.${stance}`)}
                          </span>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className={styles.note}>{td('mayDo.everyone')}</p>
            </div>

            <div className={styles.block} data-testid="profile-systems">
              <h3 className={styles.subtitle}>{t('systems.title')}</h3>
              {access === null ? (
                <p className={styles.quiet} data-testid="profile-systems-unread">
                  {t('systems.unread')}
                </p>
              ) : access.choices.length === 0 ? (
                <p className={styles.quiet}>{t('systems.none')}</p>
              ) : (
                <ul className={styles.rows} data-testid="profile-systems-rows">
                  {access.choices.map((choice) => {
                    const on = (draft.access ?? access.allowed).includes(choice.key);
                    return (
                      <li
                        key={choice.key}
                        className={styles.row}
                        data-testid={`profile-system-${choice.key}`}
                      >
                        <span className={styles.rowName}>
                          <bdi dir="auto">{choice.name}</bdi>
                          <span className={styles.state}>
                            {t(`systems.state.${accessState(choice)}`)}
                          </span>
                        </span>
                        <input
                          type="checkbox"
                          role="switch"
                          className={hire.switch}
                          checked={on}
                          aria-label={t('systems.mayUse', { name: choice.name })}
                          data-testid={`profile-system-${choice.key}-on`}
                          onChange={(e) => {
                            const rest = (draft.access ?? access.allowed).filter(
                              (key) => key !== choice.key,
                            );
                            set({ access: e.target.checked ? [...rest, choice.key] : rest });
                          }}
                        />
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className={styles.note}>{t('systems.later')}</p>
            </div>
          </section>

          <section className={styles.section} data-testid="profile-handover">
            <h2 className={styles.title}>{t('handover.title')}</h2>
            <p className={styles.quiet}>{t('handover.lead')}</p>
            {draft.rules.length === 0 ? (
              <p className={styles.quiet} data-testid="profile-rules-none">
                {t('handover.none')}
              </p>
            ) : (
              <ol className={styles.rules} data-testid="profile-rules">
                {draft.rules.map((rule, i) => (
                  <li key={i} className={styles.rule} data-testid={`profile-rule-${i}`}>
                    <input
                      type="checkbox"
                      className={styles.ruleOn}
                      checked={rule.enabled}
                      aria-label={t('handover.onFor', { n: i + 1 })}
                      data-testid={`profile-rule-${i}-on`}
                      onChange={(e) => setRule(i, { enabled: e.target.checked })}
                    />
                    <input
                      type="text"
                      className={styles.ruleLabel}
                      value={rule.label}
                      maxLength={MAX_RULE_LABEL}
                      dir={typedDir(rule.label)}
                      placeholder={t('handover.placeholder')}
                      aria-label={t('handover.labelFor', { n: i + 1 })}
                      aria-invalid={rule.label.trim() === '' ? true : undefined}
                      data-testid={`profile-rule-${i}-label`}
                      onChange={(e) => setRule(i, { label: e.target.value })}
                    />
                    <button
                      type="button"
                      className={styles.ruleRemove}
                      aria-label={t('handover.removeFor', { n: i + 1 })}
                      data-testid={`profile-rule-${i}-remove`}
                      onClick={() => set({ rules: draft.rules.filter((_, j) => j !== i) })}
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ol>
            )}
            {problem === 'empty' ? (
              <p className={styles.problem} role="status" data-testid="profile-rules-problem">
                {t('handover.empty')}
              </p>
            ) : null}
            {draft.rules.length >= MAX_RULES ? (
              <p className={styles.quiet} data-testid="profile-rules-full">
                {t('handover.full', { max: MAX_RULES })}
              </p>
            ) : (
              <button
                type="button"
                className={styles.add}
                data-testid="profile-rule-add"
                onClick={() => set({ rules: [...draft.rules, newRule()] })}
              >
                <Plus size={14} aria-hidden="true" />
                {t('handover.add')}
              </button>
            )}
          </section>
        </div>
      </div>

      {confirming ? (
        /*
          Before a working employee changes: what changes, in words, and that
          it reaches customers from its next reply - in the conversations open
          now too.
        */
        <Dialog open onOpenChange={(open) => (open ? null : setConfirming(false))}>
          <DialogContent
            title={t('confirm.title', { name: employee.name })}
            description={
              employee.openConversations > 0
                ? t('confirm.liveOpen', { count: employee.openConversations })
                : t('confirm.live')
            }
            data-testid="profile-confirm"
          >
            <ul className={styles.confirmList} data-testid="profile-confirm-changes">
              {changes.map((field) => (
                <li key={field}>{t(`field.${field}`)}</li>
              ))}
            </ul>
            {refused ? (
              <p className={styles.problem} role="alert" data-testid="profile-save-failed">
                {t(`saveProblem.${refused}`, { max: MAX_RULE_LABEL })}
              </p>
            ) : null}
            <span className={styles.confirmActions}>
              <button
                type="button"
                className={styles.confirmKeep}
                onClick={() => setConfirming(false)}
              >
                {t('confirm.keep')}
              </button>
              <button
                type="button"
                className={styles.confirmSave}
                disabled={saving}
                onClick={save}
                data-testid="profile-confirm-save"
              >
                {saving ? t('confirm.saving') : t('confirm.save')}
              </button>
            </span>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
