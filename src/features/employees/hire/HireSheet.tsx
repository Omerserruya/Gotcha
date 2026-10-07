'use client';

import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import type { AdminChoice } from '@/api/contracts/capabilities';
import drawer from '@/design-system/styles/drawer.module.css';
import { UnavailableAction } from '@/design-system/primitives/unavailable/Unavailable';
import { IntegrationLogo } from '@/features/capabilities/IntegrationLogo';
import { Link } from '@/i18n/navigation';

import {
  emptyPlan,
  HANDOVER_SUGGESTIONS,
  HIRE_JOBS,
  stepOneDone,
  toolGroups,
  type HirePlan,
  type HireTool,
} from './hire-plan';
import styles from './Hire.module.css';

type Step = 1 | 2 | 3;

/**
 * 07b-07d, measured: "Hire an AI employee" as a 1000 sheet over Studio -
 * Responsibility, Limits, Try it - the form on the left, what it means on
 * the right.
 *
 * ★ READ-ONLY, ON PURPOSE (the supervisor's ruling, pending Omer). Every
 * choice is local state (`HirePlan`); nothing is written. Continue and Back
 * move between steps. "Run the test", "Hire it" and "Hire in watch-only
 * mode" are drawn and not live. `hire-plan.ts` names the builder call each
 * choice becomes, so going live is plumbing, not redesign.
 *
 * Step 2's rows are the business's own actions as 10 reads them, with 10's
 * three answers and its ceiling ("Do it" is not offered where orders or
 * money change). Step 1's "It already knows" is the business's knowledge
 * sources - 08's read - because the builder's `GET /:id/options` needs a
 * draft id, and a draft is a write.
 */
export function HireSheet({
  tools,
  knowledge,
  initialStep = 1,
}: {
  readonly tools: readonly HireTool[];
  /** Knowledge source names, or null when they could not be read. */
  readonly knowledge: readonly string[] | null;
  readonly initialStep?: Step;
}) {
  const t = useTranslations('employees.hireFlow');
  const [step, setStep] = useState<Step>(initialStep);
  const [plan, setPlan] = useState<HirePlan>(() => emptyPlan(tools));
  /* From step 2, the head's line is the plan so far: the job. */
  const summary =
    plan.job === null
      ? null
      : plan.job === 'custom'
        ? plan.goal.trim() || t('job.custom.name')
        : t(`job.${plan.job}.name`);

  const set = (patch: Partial<HirePlan>) => setPlan((p) => ({ ...p, ...patch }));
  const toggle = (list: readonly string[], value: string) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  const go = (next: Step) => {
    setStep(next);
    // The step is in the address too, so it can be measured and reloaded.
    window.history.replaceState(null, '', `?hire=1&step=${next}`);
  };

  const groups = toolGroups(tools);

  return (
    <div className={styles.layer} data-testid="hire-sheet" data-step={step}>
      <Link
        href="/studio/employees"
        className={styles.scrim}
        aria-label={t('close')}
        tabIndex={-1}
      />
      <section className={styles.sheet} aria-label={t('title')}>
        <header className={styles.head}>
          <div className={styles.titles}>
            <h2 className={styles.title}>{t('title')}</h2>
            <p className={styles.line} data-testid="hire-line">
              {step > 1 && summary ? summary : t('line')}
            </p>
          </div>
          <ol className={styles.stepper} aria-label={t('steps')}>
            {([1, 2, 3] as const).map((n) => (
              <li
                key={n}
                className={styles.stepperStep}
                data-state={n === step ? 'current' : n < step ? 'done' : 'next'}
              >
                <span className={styles.stepperMark}>{n < step ? '✓' : n}</span>
                {t(`step.${n}`)}
              </li>
            ))}
          </ol>
          <Link href="/studio/employees" className={styles.close} aria-label={t('close')}>
            <X size={16} aria-hidden="true" />
          </Link>
        </header>

        <div className={styles.body}>
          <div className={styles.main}>
            {step === 1 ? (
              <>
                <div>
                  <h3 className={styles.question}>{t('one.title')}</h3>
                  <p className={styles.sub}>{t('one.sub')}</p>
                </div>
                <div className={styles.jobs} role="radiogroup" aria-label={t('one.title')}>
                  {HIRE_JOBS.map((job) => (
                    <button
                      key={job}
                      type="button"
                      role="radio"
                      aria-checked={plan.job === job}
                      className={styles.job}
                      data-testid={`hire-job-${job}`}
                      onClick={() => set({ job })}
                    >
                      <span className={styles.jobName}>{t(`job.${job}.name`)}</span>
                      <span className={styles.jobText}>{t(`job.${job}.text`)}</span>
                    </button>
                  ))}
                </div>
                {plan.job === 'custom' ? (
                  <label className={drawer.field}>
                    <span className={drawer.fieldLabel}>{t('one.goal')}</span>
                    <textarea
                      className={drawer.box}
                      value={plan.goal}
                      maxLength={600}
                      data-testid="hire-goal"
                      onChange={(e) => set({ goal: e.target.value })}
                    />
                  </label>
                ) : null}
                <label className={styles.block}>
                  <span className={styles.blockTitle}>{t('one.callIt')}</span>
                  <input
                    className={`${drawer.box} ${styles.nameInput}`}
                    value={plan.name}
                    maxLength={120}
                    placeholder={plan.job ? t(`job.${plan.job}.name`) : ''}
                    data-testid="hire-name"
                    onChange={(e) => set({ name: e.target.value })}
                  />
                </label>
              </>
            ) : step === 2 ? (
              <>
                <div>
                  <h3 className={styles.question}>{t('two.title')}</h3>
                  <p className={styles.sub}>{t('two.sub')}</p>
                </div>
                {tools.length === 0 ? (
                  <p className={styles.none} title={t('two.noTools')} data-testid="hire-no-tools">
                    -
                  </p>
                ) : (
                  groups.map((group) => (
                    <section
                      key={group.provider ?? 'gotcha'}
                      className={styles.group}
                      data-testid={`hire-group-${group.provider ?? 'gotcha'}`}
                    >
                      {group.provider === null ? (
                        <h4 className={styles.eyebrow}>{t('two.own')}</h4>
                      ) : (
                        <div className={styles.groupHead}>
                          <IntegrationLogo slug={group.provider} size="pill" />
                          <h4 className={styles.groupName}>{group.label ?? group.provider}</h4>
                          {/*
                            Per-employee access to an integration (Omer, 2026-10-07)
                            has no backend yet: a status, never a switch that
                            remembers nothing.
                          */}
                          <UnavailableAction
                            label={t('two.mayUse', { name: group.label ?? group.provider })}
                            tag={t('comingSoon')}
                            why={t('two.mayUseWhy')}
                            testid={`hire-may-use-${group.provider}`}
                          />
                        </div>
                      )}
                      <ul className={styles.rows}>
                        {group.tools.map((tool) => (
                          <li key={tool.toolName} className={styles.row}>
                            <span className={styles.rowName}>{tool.label}</span>
                            <span
                              className={styles.segmented}
                              role="radiogroup"
                              aria-label={
                                tool.providerLabel
                                  ? `${tool.providerLabel} · ${tool.label}`
                                  : tool.label
                              }
                            >
                              {(['do_it', 'ask_me', 'never'] as const).map((choice) => {
                                const offered = tool.choices.includes(choice);
                                return (
                                  <button
                                    key={choice}
                                    type="button"
                                    role="radio"
                                    aria-checked={plan.choices[tool.toolName] === choice}
                                    disabled={!offered}
                                    title={offered ? undefined : t('two.ceiling')}
                                    className={styles.segment}
                                    data-testid={`hire-choice-${tool.toolName}-${choice}`}
                                    onClick={() =>
                                      set({
                                        choices: {
                                          ...plan.choices,
                                          [tool.toolName]: choice as AdminChoice,
                                        },
                                      })
                                    }
                                  >
                                    {t(`two.choice.${choice}`)}
                                  </button>
                                );
                              })}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))
                )}
                <section className={styles.handover}>
                  <h4 className={styles.blockTitle}>{t('two.handover')}</h4>
                  <p className={styles.chips}>
                    {HANDOVER_SUGGESTIONS.map((h) => (
                      <button
                        key={h}
                        type="button"
                        aria-pressed={plan.handover.includes(h)}
                        className={styles.chip}
                        data-testid={`hire-handover-${h}`}
                        onClick={() => set({ handover: toggle(plan.handover, h) })}
                      >
                        {t(`two.when.${h}`)}
                      </button>
                    ))}
                    <span className={styles.chipQuiet} aria-disabled="true" title={t('notYet')}>
                      {t('two.addAnother')}
                    </span>
                  </p>
                </section>
              </>
            ) : (
              <>
                <div>
                  <h3 className={styles.question}>{t('three.title')}</h3>
                  <p className={styles.sub}>{t('three.sub')}</p>
                </div>
                <dl className={styles.strip} data-testid="hire-strip">
                  {(['reviewed', 'better', 'same', 'worse'] as const).map((k) => (
                    <div key={k} className={styles.stat}>
                      <dt className={styles.statLabel}>{t(`three.stat.${k}`)}</dt>
                      <dd className={styles.statFigure}>-</dd>
                    </div>
                  ))}
                </dl>
                <ol className={styles.cases} data-testid="hire-cases">
                  {Array.from({ length: 8 }, (_, i) => (
                    <li key={i} className={styles.case} title={t('three.notRun')}>
                      <span className={styles.caseNo}>{t('three.case', { n: i + 1 })}</span>
                      <span className={styles.none}>-</span>
                    </li>
                  ))}
                </ol>
                <span
                  className={styles.secondary}
                  aria-disabled="true"
                  title={t('three.notRun')}
                  data-testid="hire-run-test"
                >
                  {t('three.run')}
                </span>
              </>
            )}

            <footer className={styles.foot}>
              {step === 3 ? (
                <>
                  <span
                    className={styles.primary}
                    aria-disabled="true"
                    title={t('notYet')}
                    data-testid="hire-it"
                  >
                    {t('three.hire')}
                  </span>
                  <span
                    className={styles.secondary}
                    aria-disabled="true"
                    title={t('notYet')}
                    data-testid="hire-watch"
                  >
                    {t('three.watch')}
                  </span>
                </>
              ) : (
                <button
                  type="button"
                  className={styles.primary}
                  disabled={step === 1 && !stepOneDone(plan)}
                  data-testid="hire-continue"
                  onClick={() => go((step + 1) as Step)}
                >
                  {t('continue')}
                </button>
              )}
              {step === 1 ? (
                <Link href="/studio/employees" className={styles.quiet}>
                  {t('cancel')}
                </Link>
              ) : (
                <button
                  type="button"
                  className={styles.quiet}
                  data-testid="hire-back"
                  onClick={() => go((step - 1) as Step)}
                >
                  {t('back')}
                </button>
              )}
              <span className={styles.footNote}>{t(`note.${step}`)}</span>
            </footer>
          </div>

          <aside className={styles.side}>
            {step === 1 ? (
              <>
                <h4 className={styles.eyebrow}>{t('side.dayOne')}</h4>
                <p className={styles.sideLead} data-testid="hire-day-one">
                  {plan.job ? t(`job.${plan.job}.dayOne`) : '-'}
                </p>
                <h4 className={styles.sideLabel}>{t('side.knows')}</h4>
                {knowledge && knowledge.length > 0 ? (
                  <ul className={styles.sideList} data-testid="hire-knows">
                    {knowledge.slice(0, 4).map((k) => (
                      <li key={k}>{k}</li>
                    ))}
                  </ul>
                ) : (
                  <p className={styles.none} title={t('side.knowsNone')}>
                    -
                  </p>
                )}
              </>
            ) : step === 2 ? (
              <>
                <h4 className={styles.eyebrow}>{t('side.cost')}</h4>
                {/* Nothing estimates it yet: said, never a dash before a unit. */}
                <p className={styles.sideLead} data-testid="hire-cost">
                  {t('side.costNone')}
                </p>
              </>
            ) : (
              <>
                <h4 className={styles.eyebrow}>{t('side.soFar')}</h4>
                <p className={styles.sideFigure} title={t('three.notRun')}>
                  -
                </p>
              </>
            )}
            <p className={styles.sideNext}>{t(`side.next.${step}`)}</p>
          </aside>
        </div>
      </section>
    </div>
  );
}
