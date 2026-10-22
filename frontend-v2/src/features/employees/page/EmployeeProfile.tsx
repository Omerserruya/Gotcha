'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useState, useTransition, type ReactNode } from 'react';

import { humaniseCode } from '@/api/contracts/capabilities';
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
  limitsProblem,
  MAX_RULE_LABEL,
  rulesProblem,
  type ProfileDraft,
} from './profile-plan';
import { EmployeeLimits } from './EmployeeLimits';
import { HandoverRules } from './HandoverRules';
import styles from './EmployeePage.module.css';
import { EmployeeToolLevels, type ToolLevelRow } from './EmployeeToolLevels';

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
 * Readiness (H7) sits above them: what it is not ready for, and Run again.
 *
 * Save asks first, naming what changes and that it reaches live customers
 * from the next reply - the runtime reads the employee on every reply, so
 * open conversations take it too. Then one PATCH.
 */
export function EmployeeProfile({
  employee,
  head,
  tabs,
  levels,
  access = null,
  readiness = null,
}: {
  readonly employee: Employee;
  /** The page's head (avatar, name, standing) - Save sits beside it. */
  readonly head: ReactNode;
  readonly tabs: ReactNode;
  /** E5: every action this employee may use, its level and the workspace's; `null` when unread. */
  readonly levels: readonly ToolLevelRow[] | null;
  /** The business systems it may use, and every one set up; `null` when unread. */
  readonly access?: IntegrationAccess | null;
  /** H7: the readiness card, first in the list. */
  readonly readiness?: ReactNode;
}) {
  const t = useTranslations('employees.profile');
  const td = useTranslations('employees.detail');
  const format = useFormatter();
  const router = useRouter();
  const stored = access?.allowed ?? null;
  const [draft, setDraft] = useState<ProfileDraft>(() => draftOf(employee, stored));
  const set = (patch: Partial<ProfileDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const changes = changesIn(employee, draft, stored);
  const problem = rulesProblem(draft.rules) ?? limitsProblem(draft.limits);
  const [confirming, setConfirming] = useState(false);
  const [refused, setRefused] = useState<Exclude<EmployeeEditResult, { ok: true }> | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, startSave] = useTransition();

  const save = () =>
    startSave(async () => {
      setRefused(null);
      const result = await saveEmployeeEdits(employee.id, editPatch(employee, draft, stored));
      if (!result.ok) {
        setRefused(result);
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
          {readiness}
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
                {/*
                  A label around the words and the switch (dev, 2026-10-13):
                  pressing the words toggles it, as on every switch here.
                */}
                <dd>
                  <label className={styles.switchRow} data-testid="profile-discloses-row">
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
                  </label>
                </dd>
              </div>
            </dl>
          </section>

          <section className={styles.section} data-testid="profile-tools">
            {/* E3 (2026-10-14): its tools, by integration; "Limits" is its own rules now (E4). */}
            <h2 className={styles.title}>{t('tools.title')}</h2>

            {/*
              What it may do: THIS employee's level per action (E5, Backend
              a9fc1aca), never looser than the workspace's - see
              EmployeeToolLevels.
            */}
            <div className={styles.block} data-testid="profile-may-do">
              <h3 className={styles.subtitle}>{td('mayDo.title')}</h3>
              <EmployeeToolLevels employeeId={employee.id} rows={levels} />
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
                        <label className={styles.switchLabel}>
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
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className={styles.note}>{t('systems.later')}</p>
            </div>
          </section>

          {/* ★★ E4 (2026-10-14): its own rules, in the owner's words - see EmployeeLimits. */}
          <section className={styles.section} data-testid="profile-limits">
            <h2 className={styles.title}>{t('limits.title')}</h2>
            <p className={styles.quiet}>{t('limits.lead')}</p>
            <EmployeeLimits
              limits={draft.limits}
              refusedAt={refused?.reason === 'invalid_limits' ? refused.index : null}
              onChange={(limits) => {
                // A refused rule's place is the list's as sent: an edit moves it.
                if (refused?.reason === 'invalid_limits') setRefused(null);
                set({ limits });
              }}
            />
          </section>

          <section className={styles.section} data-testid="profile-handover">
            <h2 className={styles.title}>{t('handover.title')}</h2>
            <p className={styles.quiet}>{t('handover.lead')}</p>
            <HandoverRules id="profile" rules={draft.rules} onChange={(rules) => set({ rules })} />
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
                {refused.reason === 'invalid_limits'
                  ? t(`saveProblem.limits.${refused.why}`, {
                      n: (refused.index ?? 0) + 1,
                      max: refused.max ?? 0,
                    })
                  : t(`saveProblem.${refused.reason}`, { max: MAX_RULE_LABEL })}
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
