'use client';

import { X } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useRef, useState, useTransition } from 'react';

import { humaniseCode, type CapabilityStance } from '@/api/contracts/capabilities';
import {
  accessState,
  EMPLOYEE_TONES,
  type Employee,
  type IntegrationAccess,
} from '@/api/contracts/employees';
import { Dialog, DialogContent } from '@/design-system/primitives/overlay/Dialog';
import { UserText } from '@/design-system/primitives/text/UserText';
import { pressSheetClose, useSheetFocus } from '@/design-system/primitives/overlay/use-sheet-focus';
import { Link, useRouter } from '@/i18n/navigation';

import { saveEmployeeEdits, type EmployeeEditResult } from '../actions';

import hire from '../hire/Hire.module.css';
import { changesIn, draftOf, EDIT_LANGUAGES, editPatch, type EditDraft } from './edit-plan';
import { automationsLink, WhoAnswers, type ReachItem } from '../WhoAnswers';
import styles from './Edit.module.css';

export type EditMayDo = {
  readonly toolName: string;
  readonly label: string;
  readonly stance: CapabilityStance;
};

const STANCES = ['on_its_own', 'ask_first', 'never'] as const;

/**
 * 07f, measured: "Edit {name}" - a 1000 sheet over Studio, the same
 * sentences as the profile, now editable, with a dark column on the right
 * and Save at its foot.
 *
 * ── EDITS HERE, SAVED (Omer, 2026-10-08) ──
 *   Responsible for, Tone, Languages, the handover rules' boxes, and the
 *   business systems it may use. Save asks first - naming what changes, and
 *   that it reaches live customers from the next reply - then one PATCH.
 *
 * ── DRAWN, AND WHY ──
 *   What it handles       nothing groups conversations by topic
 *   Signs off as          no field holds a signature
 *   Says it is AI         no field holds a disclosure rule
 *   What it may do        the business's, the same for every employee - set
 *                         in Integrations, not here
 *   Hands to              no handover target is stored
 *   Preview               nothing replays a conversation under new rules
 *
 * ★ The head says when changes apply because the runtime reads the employee
 * on every reply (`ai-bot.service.ts`, `findUnique` per message): open
 * conversations take them too. 02's "open ones finish under the current
 * rules" is not this platform, and nothing writes an audit row for a PATCH.
 */
export function EditSheet({
  employee,
  tools,
  mayDo,
  access = null,
  reach = null,
}: {
  readonly employee: Employee;
  /** Connected systems, named; `null` when the read failed. */
  readonly tools: readonly string[] | null;
  /** `null` when the read failed. */
  readonly mayDo: readonly EditMayDo[] | null;
  /** The business systems it may use, and every one set up; `null` when unread. */
  readonly access?: IntegrationAccess | null;
  /** Where it answers, by the playbook; `null` when unread. */
  readonly reach?: readonly ReachItem[] | null;
}) {
  const t = useTranslations('employees.edit');
  const td = useTranslations('employees.detail');
  const te = useTranslations('employees');
  const format = useFormatter();
  const [draft, setDraft] = useState<EditDraft>(() => draftOf(employee, access?.allowed ?? null));
  const set = (patch: Partial<EditDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const changes = changesIn(employee, draft, access?.allowed ?? null);
  const back = { pathname: '/studio/employees', query: { employee: employee.id } } as const;
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<
    Exclude<EmployeeEditResult, { ok: true }>['reason'] | null
  >(null);
  const [saving, startSave] = useTransition();
  const save = () =>
    startSave(async () => {
      setProblem(null);
      const result = await saveEmployeeEdits(
        employee.id,
        editPatch(employee, draft, access?.allowed ?? null),
      );
      if (!result.ok) {
        setProblem(result.reason);
        return;
      }
      setConfirming(false);
      // Back to the employee, read again: what is shown is what was stored.
      router.replace(back, { scroll: false });
      router.refresh();
    });

  const toneName = (tone: string) =>
    (EMPLOYEE_TONES as readonly string[]).includes(tone)
      ? td(`tone.${tone}` as 'tone.friendly')
      : humaniseCode(tone);
  // The stored tone stays offered, even one the builder no longer writes.
  const tones = [...new Set([...EMPLOYEE_TONES, ...(employee.tone ? [employee.tone] : [])])];

  // Escape is a press on ×; focus stays in the sheet and goes back to Edit.
  const sheetRef = useRef<HTMLElement>(null);
  useSheetFocus(sheetRef, { onEscape: () => pressSheetClose(sheetRef.current) });

  return (
    <div className={hire.layer} data-testid="edit-sheet">
      <Link
        href={back}
        className={hire.scrim}
        aria-label={t('close')}
        tabIndex={-1}
        scroll={false}
      />
      <section
        ref={sheetRef}
        className={hire.sheet}
        role="dialog"
        aria-modal="true"
        aria-label={t('title', { name: employee.name })}
        tabIndex={-1}
      >
        <header className={hire.head}>
          <div className={hire.titles}>
            <h2 className={hire.title}>{t('title', { name: employee.name })}</h2>
            <p className={hire.line} data-testid="edit-line">
              {employee.openConversations > 0
                ? t('applyOpen', { count: employee.openConversations })
                : t('apply')}
            </p>
          </div>
          {employee.updatedAt ? (
            <span className={styles.edited} data-testid="edit-edited">
              {t('edited', { when: format.relativeTime(new Date(employee.updatedAt)) })}
            </span>
          ) : null}
          <Link
            href={back}
            className={hire.close}
            aria-label={t('close')}
            scroll={false}
            data-sheet-close
          >
            <X size={16} aria-hidden="true" />
          </Link>
        </header>

        <div className={styles.body}>
          <div className={styles.main}>
            <section className={`${styles.card} ${styles.wide}`}>
              <h3 className={styles.cardTitle}>{t('responsible')}</h3>
              <textarea
                className={styles.field}
                rows={2}
                value={draft.responsibility}
                placeholder={t('responsiblePlaceholder')}
                aria-label={t('responsible')}
                data-testid="edit-responsibility"
                onChange={(e) => set({ responsibility: e.target.value })}
              />
            </section>

            {/* No "What it handles", and no "+ Add" that did nothing (Omer, 2026-10-13, E4). */}
            <section className={styles.card} data-testid="edit-how">
              <h3 className={styles.cardTitle}>{t('how')}</h3>
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
                          data-testid={`edit-tone-${tone}`}
                          onClick={() => set({ tone })}
                        >
                          {toneName(tone)}
                        </button>
                      ))}
                    </span>
                  </dd>
                </div>
                <div className={styles.pair}>
                  <dt>{t('languages')}</dt>
                  <dd className={styles.chips}>
                    {EDIT_LANGUAGES.map((language) => (
                      <button
                        key={language}
                        type="button"
                        aria-pressed={draft.languages[language] === true}
                        className={styles.toggle}
                        data-testid={`edit-language-${language}`}
                        onClick={() =>
                          set({
                            languages: {
                              ...draft.languages,
                              [language]: draft.languages[language] !== true,
                            },
                          })
                        }
                      >
                        {td(`language.${language}`)}
                      </button>
                    ))}
                  </dd>
                </div>
                <div className={styles.pair}>
                  <dt>{t('signsOff')}</dt>
                  <dd className={styles.none} title={t('signsOffNone')}>
                    -
                  </dd>
                </div>
                <div className={styles.pair}>
                  <dt>{t('saysAi')}</dt>
                  <dd className={styles.none} title={t('saysAiNone')}>
                    -
                  </dd>
                </div>
              </dl>
            </section>

            <section className={styles.card} data-testid="edit-may-do">
              <h3 className={styles.cardTitle} title={td('mayDo.everyone')}>
                {td('mayDo.title')}
              </h3>
              {mayDo === null ? (
                <p className={styles.none} title={td('mayDo.unavailable')}>
                  -
                </p>
              ) : mayDo.length === 0 ? (
                <p className={styles.none} title={td('mayDo.none')}>
                  -
                </p>
              ) : (
                <ul className={`${styles.rows} ${styles.scroll}`} data-testid="edit-may-rows">
                  {mayDo.map((row) => (
                    <li key={row.toolName} className={styles.mayRow}>
                      <span className={styles.mayName} title={row.label}>
                        {row.label}
                      </span>
                      <span className={styles.stances}>
                        {STANCES.map((stance) => (
                          <span
                            key={stance}
                            className={styles.stance}
                            data-stance={stance}
                            data-current={row.stance === stance ? 'yes' : 'no'}
                            aria-disabled="true"
                            title={td('mayDo.everyone')}
                            data-testid={`edit-may-${row.toolName}-${stance}`}
                          >
                            {td(`mayDo.${stance}`)}
                          </span>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/*
              The business systems it may use (Backend 00c6c229). A status per
              system until saving a working employee is approved (supervisor,
              (b)): "On" / "Off", never a switch that remembers nothing. The
              field is in the draft, so Save going live sends it.
            */}
            <section className={styles.card} data-testid="edit-systems">
              <h3 className={styles.cardTitle}>{t('systems.title')}</h3>
              {access === null ? (
                <p
                  className={styles.none}
                  title={t('systems.unread')}
                  data-testid="edit-systems-unread"
                >
                  -
                </p>
              ) : access.choices.length === 0 ? (
                <p className={styles.none} title={t('systems.none')}>
                  -
                </p>
              ) : (
                <ul className={styles.rows} data-testid="edit-systems-rows">
                  {access.choices.map((choice) => {
                    const on = (draft.access ?? access.allowed).includes(choice.key);
                    return (
                      <li
                        key={choice.key}
                        className={styles.mayRow}
                        data-testid={`edit-system-${choice.key}`}
                      >
                        <span className={styles.mayName}>
                          <bdi dir="auto">{choice.name}</bdi>
                          <span className={styles.systemState}>
                            {t(`systems.state.${accessState(choice)}`)}
                          </span>
                        </span>
                        <input
                          type="checkbox"
                          role="switch"
                          className={hire.switch}
                          checked={on}
                          aria-label={t('systems.mayUse', { name: choice.name })}
                          data-testid={`edit-system-${choice.key}-on`}
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
              <p className={styles.systemsLater} data-testid="edit-systems-later">
                {t('systems.later')}
              </p>
            </section>

            <section className={styles.card} data-testid="edit-handover">
              <h3 className={styles.cardTitle}>{td('handover.title')}</h3>
              {employee.escalationRules.length === 0 ? (
                <p className={styles.none} title={td('handover.none')}>
                  -
                </p>
              ) : (
                <ul className={styles.rows}>
                  {employee.escalationRules.map((rule, i) => (
                    <li key={i}>
                      <label className={styles.check}>
                        <input
                          type="checkbox"
                          checked={draft.handover[i] === true}
                          data-testid={`edit-rule-${i}`}
                          onChange={() =>
                            set({
                              handover: draft.handover.map((on, j) => (j === i ? !on : on)),
                            })
                          }
                        />
                        {rule.label.trim() ? <UserText>{rule.label}</UserText> : '-'}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              <p className={styles.handsTo}>
                {t('handsTo')}{' '}
                <span className={styles.none} title={t('handsToNone')}>
                  -
                </span>
              </p>
            </section>

            <section className={styles.muted} data-testid="edit-channels">
              <h3 className={styles.mutedTitle}>{td('answersOn.title')}</h3>
              <WhoAnswers
                className={styles.none}
                text={te.rich('whoAnswers', { automations: automationsLink })}
                reach={reach}
                where={te.rich('reach.where', { automations: automationsLink })}
                nowhere={te.rich('reach.nowhere', { automations: automationsLink })}
              />
            </section>

            <section className={styles.muted} data-testid="edit-tools">
              <h3 className={styles.mutedTitle}>
                {td('tools.title')}
                <span className={styles.meta}>{t('setInCore')}</span>
              </h3>
              {tools && tools.length > 0 ? (
                <ul className={styles.rows}>
                  {tools.map((tool) => (
                    <li key={tool} className={styles.mutedRow}>
                      {tool}
                    </li>
                  ))}
                </ul>
              ) : (
                <p
                  className={styles.none}
                  title={tools === null ? td('tools.unavailable') : td('tools.none')}
                >
                  -
                </p>
              )}
            </section>
          </div>

          <aside className={styles.side}>
            <h3 className={styles.sideTitle}>{t('preview')}</h3>
            <p className={styles.sideNone} title={t('previewNone')} data-testid="edit-preview">
              -
            </p>
            <div className={styles.sideFoot}>
              <button
                type="button"
                className={styles.save}
                disabled={changes.length === 0 || saving}
                onClick={() => {
                  setProblem(null);
                  setConfirming(true);
                }}
                data-testid="edit-save"
              >
                {t('save')}
              </button>
              <Link href={back} className={styles.cancel} scroll={false}>
                {t('cancel')}
              </Link>
              <p className={styles.changes} data-testid="edit-changes">
                {changes.length > 0 ? t('changes', { count: changes.length }) : t('noChanges')}
              </p>
            </div>
          </aside>
          {confirming ? (
            /*
              Before a working employee changes: what changes, in words, and
              that it reaches customers from its next reply - in the
              conversations open now too.
            */
            <Dialog open onOpenChange={(open) => (open ? null : setConfirming(false))}>
              <DialogContent
                title={t('confirm.title', { name: employee.name })}
                description={
                  employee.openConversations > 0
                    ? t('confirm.liveOpen', { count: employee.openConversations })
                    : t('confirm.live')
                }
                data-testid="edit-confirm"
              >
                <ul className={styles.confirmList} data-testid="edit-confirm-changes">
                  {changes.map((field) => (
                    <li key={field}>{t(`field.${field}`)}</li>
                  ))}
                </ul>
                {problem ? (
                  <p className={styles.confirmProblem} role="alert" data-testid="edit-save-failed">
                    {t(`saveProblem.${problem}`)}
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
                    data-testid="edit-confirm-save"
                  >
                    {saving ? t('confirm.saving') : t('confirm.save')}
                  </button>
                </span>
              </DialogContent>
            </Dialog>
          ) : null}
        </div>
      </section>
    </div>
  );
}
