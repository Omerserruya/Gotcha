'use client';

import { X } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';

import { humaniseCode, type CapabilityStance } from '@/api/contracts/capabilities';
import { EMPLOYEE_TONES, type Employee } from '@/api/contracts/employees';
import { UserText } from '@/design-system/primitives/text/UserText';
import { Link } from '@/i18n/navigation';

import hire from '../hire/Hire.module.css';
import { changesIn, draftOf, EDIT_LANGUAGES, type EditDraft } from './edit-plan';
import { automationsLink, WhoAnswers } from '../WhoAnswers';
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
 * ── EDITS HERE (locally; Save is not live) ──
 *   Responsible for, Tone, Languages, the handover rules' boxes
 *
 * ── DRAWN, AND WHY ──
 *   What it handles       nothing groups conversations by topic
 *   Signs off as          no field holds a signature
 *   Says it is AI         no field holds a disclosure rule
 *   What it may do        the business's, the same for every employee - set
 *                         in Integrations, not here
 *   Hands to              no handover target is stored
 *   Preview               nothing replays a conversation under new rules
 *   Save changes          changes how a working employee answers: Omer's call
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
}: {
  readonly employee: Employee;
  /** Connected systems, named; `null` when the read failed. */
  readonly tools: readonly string[] | null;
  /** `null` when the read failed. */
  readonly mayDo: readonly EditMayDo[] | null;
}) {
  const t = useTranslations('employees.edit');
  const td = useTranslations('employees.detail');
  const te = useTranslations('employees');
  const format = useFormatter();
  const [draft, setDraft] = useState<EditDraft>(() => draftOf(employee));
  const set = (patch: Partial<EditDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const changes = changesIn(employee, draft);
  const back = { pathname: '/studio/employees', query: { employee: employee.id } } as const;

  const toneName = (tone: string) =>
    (EMPLOYEE_TONES as readonly string[]).includes(tone)
      ? td(`tone.${tone}` as 'tone.friendly')
      : humaniseCode(tone);
  // The stored tone stays offered, even one the builder no longer writes.
  const tones = [...new Set([...EMPLOYEE_TONES, ...(employee.tone ? [employee.tone] : [])])];

  return (
    <div className={hire.layer} data-testid="edit-sheet">
      <Link
        href={back}
        className={hire.scrim}
        aria-label={t('close')}
        tabIndex={-1}
        scroll={false}
      />
      <section className={hire.sheet} aria-label={t('title', { name: employee.name })}>
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
          <Link href={back} className={hire.close} aria-label={t('close')} scroll={false}>
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

            <section className={styles.card} data-testid="edit-handles">
              <h3 className={styles.cardTitle}>{t('handles')}</h3>
              <div className={styles.chips}>
                <span className={styles.none} title={t('handlesNone')}>
                  -
                </span>
                <span className={styles.add} aria-disabled="true" title={t('handlesNone')}>
                  {t('add')}
                </span>
              </div>
            </section>

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
              <span
                role="button"
                className={styles.save}
                aria-disabled="true"
                title={t('saveNotYet')}
                data-testid="edit-save"
              >
                {t('save')}
              </span>
              <Link href={back} className={styles.cancel} scroll={false}>
                {t('cancel')}
              </Link>
              <p className={styles.changes} data-testid="edit-changes">
                {changes.length > 0 ? t('changes', { count: changes.length }) : t('noChanges')}
              </p>
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
}
