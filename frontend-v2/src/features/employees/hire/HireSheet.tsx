'use client';

import { X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState, useTransition } from 'react';

import type { AdminChoice } from '@/api/contracts/capabilities';
import { pressSheetClose, useSheetFocus } from '@/design-system/primitives/overlay/use-sheet-focus';
import drawer from '@/design-system/styles/drawer.module.css';
import { IntegrationLogo } from '@/features/capabilities/IntegrationLogo';
import { humaniseCode } from '@/api/contracts/capabilities';
import { Link, useRouter } from '@/i18n/navigation';

import {
  allowedChoices,
  emptyPlan,
  hireBlocks,
  hireKnowledgeIds,
  hireRequest,
  hireSkillIds,
  knowledgeDefault,
  NEW_HIRE,
  needsFunnel,
  chosenFunnel,
  withAccess,
  writesOf,
  HANDOVER_SUGGESTIONS,
  HIRE_JOBS,
  stepOneDone,
  toolGroups,
  type HirePlan,
  type HireFunnels,
  type HireTemplates,
  type HireResult,
  type HireSkill,
  type HireSource,
  type HireTool,
  type HireWrite,
} from './hire-plan';
import { hireEmployee } from './hire-actions';
import { clearDraft, hasEntries, loadDraft, saveDraft, type HireStep } from './hire-draft';
import { HandoverRules } from '../page/HandoverRules';
import { reachedByScope, reachOf } from '../page/knowledge-plan';
import { MAX_RULES, rulesProblem } from '../page/profile-plan';
import page from '../page/EmployeePage.module.css';
import styles from './Hire.module.css';

type Step = HireStep;
const STEPS = [1, 2, 3, 4] as const;

/**
 * 07b-07d, measured: "Hire an AI employee" as a 1000 sheet over Studio -
 * the form on the left, what it means on the right. Four steps (Omer,
 * 2026-10-13, H4): Responsibility, Limits, Knowledge and skills, Summary.
 *
 * ★★ HIRING IS REAL (H5). Every choice is local state (`HirePlan`) until
 * the summary's "Hire" is confirmed - "עברת על כל הסיכום של העובד?" - and
 * only that "yes" writes: `hire-actions.ts` creates a builder DRAFT, writes
 * the plan onto it, and completes it last. "No" sends nothing. A write that
 * fails stops it, and the sheet says what was saved and what was not; the
 * draft is kept, and hiring again continues it. Success clears the local
 * hire and opens 07e's "Hired".
 *
 * The summary is editable by its "Edit"s, each back to its step.
 *
 * ★ H8 (Backend 9339ca26): each integration action is given to it or not
 * ("Give it this"), "Says it's AI when asked" is the Profile tab's switch,
 * and a Sales hire picks the funnel it follows.
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
  skills = null,
  funnels = [],
  templates = [],
  initialStep = 1,
  systems = null,
  viewerId = null,
}: {
  /** Who is hiring (`User.id`, per workspace): their draft is kept under it (H6). `null`: none kept. */
  readonly viewerId?: string | null;
  readonly tools: readonly HireTool[];
  /** The workspace's knowledge bases, with their scope; `null` when unread. */
  readonly knowledge: readonly HireSource[] | null;
  /** The business skills it may carry; `null` when unread. */
  readonly skills?: readonly HireSkill[] | null;
  /** The active sales funnels, or why they are not known (ADMIN only). */
  readonly funnels?: HireFunnels;
  /** The ready-made funnels a Sales hire may start from, or why they are not known. */
  readonly templates?: HireTemplates;
  readonly initialStep?: Step;
  /** The systems the workspace has set up (any state); `null` when unread. */
  readonly systems?:
    readonly { readonly slug: string; readonly name?: string; readonly failing: boolean }[] | null;
}) {
  const t = useTranslations('employees.hireFlow');
  const tp = useTranslations('employees.profile');
  const tk = useTranslations('employees.knowsTab');
  const [step, setStep] = useState<Step>(initialStep);
  const setUp = systems?.map((system) => system.slug) ?? [];
  /* Where a new hire starts: the first chip's condition, in the reader's words. */
  const fresh = () =>
    emptyPlan(tools, setUp, {
      rules: [{ label: t(`two.when.${HANDOVER_SUGGESTIONS[0]}`), enabled: true }],
      knowledge: knowledgeDefault(knowledge),
    });
  const [plan, setPlan] = useState<HirePlan>(fresh);
  /*
    ★★ H6 (Omer, 2026-10-13): a hire that was closed continues where it
    stopped - see `hire-draft.ts`. Read after mounting (there is no storage
    on the server), and nothing is written until it has been read, so the
    first render's empty plan never wipes a stored one.
  */
  const [loaded, setLoaded] = useState(false);
  const [restored, setRestored] = useState(false);
  const [asking, setAsking] = useState(false);
  /* H5: the draft a stopped hire left, the confirmation, and how it went. */
  const [agentId, setAgentId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState<Extract<HireResult, { ok: false }> | null>(null);
  const [hired, setHired] = useState(false);
  const [hiring, startHiring] = useTransition();
  const locale = useLocale();
  const router = useRouter();
  useEffect(() => {
    const draft = loadDraft(viewerId, tools, fresh());
    const id = window.setTimeout(() => {
      if (draft) {
        setPlan(draft.plan);
        setStep(draft.step);
        setAgentId(draft.agentId ?? null);
        setRestored(true);
      }
      setLoaded(true);
    }, 0);
    return () => window.clearTimeout(id);
    // Once, on opening: the draft is read for the sheet as it opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const entered = hasEntries(plan, fresh());
  useEffect(() => {
    // Hired: the local hire is cleared once, and never written back.
    if (!loaded || hired) return;
    if (entered || agentId) saveDraft(viewerId, { step, plan, ...(agentId ? { agentId } : {}) });
    else clearDraft(viewerId);
  }, [loaded, hired, entered, agentId, viewerId, step, plan]);

  /* × , the scrim and Escape (a press on ×) ask first when anything was entered. */
  const closing = (event: { preventDefault: () => void }) => {
    if (!entered) return;
    event.preventDefault();
    setAsking(true);
  };
  const startOver = () => {
    clearDraft(viewerId);
    setPlan(fresh());
    setAgentId(null);
    setFailed(null);
    setRestored(false);
    setAsking(false);
    go(1);
  };
  const failing = new Set(systems?.filter((s) => s.failing).map((s) => s.slug) ?? []);
  /* From step 2, the head's line is the plan so far: the job. */
  const summary =
    plan.job === null
      ? null
      : plan.job === 'custom'
        ? plan.goal.trim() || t('job.custom.name')
        : t(`job.${plan.job}.name`);

  const set = (patch: Partial<HirePlan>) => setPlan((p) => ({ ...p, ...patch }));
  /* The chips not already a condition, word for word: each one a quick add (H3). */
  const suggestions = HANDOVER_SUGGESTIONS.filter(
    (h) => !plan.rules.some((rule) => rule.label.trim() === t(`two.when.${h}`)),
  );

  const go = (next: Step) => {
    setStep(next);
    setConfirming(false);
    // The step is in the address too, so it can be measured and reloaded.
    window.history.replaceState(null, '', `?hire=1&step=${next}`);
  };

  const groups = toolGroups(tools);
  const goal =
    plan.job === null ? '' : plan.job === 'custom' ? plan.goal.trim() : t(`job.${plan.job}.dayOne`);
  const blocks = hireBlocks(plan, knowledge, funnels, templates);
  const given = tools.filter((tool) => tool.grant?.grantable && plan.grants[tool.toolName]);
  const chosen = chosenFunnel(plan, funnels, templates);
  const funnelName =
    chosen === null
      ? null
      : 'id' in chosen
        ? ((typeof funnels === 'string' ? null : funnels.find((f) => f.id === chosen.id)?.name) ??
          null)
        : t('four.fromTemplate', {
            name:
              (typeof templates === 'string'
                ? null
                : templates.find((x) => x.id === chosen.template)?.name) ?? chosen.template,
          });
  const requestOf = () =>
    hireRequest(plan, {
      goal,
      tools,
      sources: knowledge ?? [],
      skills,
      locale,
      funnels,
      templates,
    });
  const connected = knowledge ? hireKnowledgeIds(plan, knowledge) : [];
  const carried = skills ? hireSkillIds(plan, skills) : plan.skills;
  const systemName = (slug: string) =>
    systems?.find((s) => s.slug === slug)?.name ??
    tools.find((tool) => tool.provider === slug)?.providerLabel ??
    humaniseCode(slug);
  const toggleIn = (list: readonly string[], id: string, on: boolean) =>
    on ? [...list.filter((x) => x !== id), id] : list.filter((x) => x !== id);

  /* H5: only the confirmation's "yes" runs this. */
  const hire = () =>
    startHiring(async () => {
      setFailed(null);
      const result = await hireEmployee(requestOf(), agentId);
      setConfirming(false);
      if (!result.ok) {
        setAgentId(result.id);
        setFailed(result);
        return;
      }
      setHired(true);
      clearDraft(viewerId);
      router.push({
        pathname: '/studio/employees',
        query: { employee: result.id, hired: result.id },
      });
    });

  // Escape is a press on ×; focus stays in the sheet and goes back to "Hire".
  const sheetRef = useRef<HTMLElement>(null);
  useSheetFocus(sheetRef, { onEscape: () => pressSheetClose(sheetRef.current) });

  return (
    <div className={styles.layer} data-testid="hire-sheet" data-step={step}>
      <Link
        href="/studio/employees"
        className={styles.scrim}
        aria-label={t('close')}
        tabIndex={-1}
        onClick={closing}
      />
      <section
        ref={sheetRef}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label={t('title')}
        tabIndex={-1}
      >
        <header className={styles.head}>
          <div className={styles.titles}>
            <h2 className={styles.title}>{t('title')}</h2>
            <p className={styles.line} data-testid="hire-line">
              {step > 1 && summary ? summary : t('line')}
            </p>
          </div>
          <ol className={styles.stepper} aria-label={t('steps')}>
            {STEPS.map((n) => (
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
          <Link
            href="/studio/employees"
            className={styles.close}
            aria-label={t('close')}
            data-sheet-close
            data-testid="hire-close"
            onClick={closing}
          >
            <X size={16} aria-hidden="true" />
          </Link>
        </header>

        {asking ? (
          <div className={styles.draftBar} role="alertdialog" data-testid="hire-close-ask">
            <span>{t('draft.closeAsk')}</span>
            <button
              type="button"
              className={styles.draftPrimary}
              data-testid="hire-close-yes"
              onClick={() => {
                setAsking(false);
                router.push('/studio/employees');
              }}
            >
              {t('draft.closeYes')}
            </button>
            <button
              type="button"
              className={styles.draftSecondary}
              data-testid="hire-close-no"
              onClick={() => setAsking(false)}
            >
              {t('draft.closeNo')}
            </button>
          </div>
        ) : restored ? (
          <div className={styles.draftBar} data-testid="hire-restored">
            <span>{t('draft.restored')}</span>
            <button
              type="button"
              className={styles.draftSecondary}
              data-testid="hire-start-over"
              onClick={startOver}
            >
              {t('draft.startOver')}
            </button>
          </div>
        ) : null}

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
                    /*
                      A person's name, whatever the job (Omer, 2026-10-13, H1):
                      the job's title ("תיאום תורים") read as what to type.
                    */
                    placeholder={t('one.namePlaceholder')}
                    data-testid="hire-name"
                    onChange={(e) => set({ name: e.target.value })}
                  />
                </label>
                {plan.job !== null && plan.name.trim() === '' ? (
                  <p className={styles.sub} data-testid="hire-name-needed">
                    {t('one.nameNeeded')}
                  </p>
                ) : null}
                {/*
                  ★ H8c: a Sales employee follows a funnel - the role and the
                  funnel go together in the one PATCH. Its row's id is bound,
                  never the slug. None, unread and refused are each said.
                */}
                {needsFunnel(plan.job) ? (
                  <section className={styles.block} data-testid="hire-funnels">
                    <h4 className={styles.blockTitle}>{t('one.funnel')}</h4>
                    <p className={styles.sub}>{t('one.funnelLead')}</p>
                    {funnels === 'forbidden' || templates === 'forbidden' ? (
                      <p className={styles.notice} data-testid="hire-funnels-forbidden">
                        {t('one.funnelForbidden')}
                      </p>
                    ) : null}
                    {funnels === 'failed' ? (
                      <p className={styles.notice} data-testid="hire-funnels-failed">
                        {t('one.funnelFailed')}
                      </p>
                    ) : funnels === 'forbidden' ? null : funnels.length === 0 ? (
                      <p className={styles.sub} data-testid="hire-funnels-none">
                        {t('one.funnelNone')}
                      </p>
                    ) : (
                      <div className={styles.chips} role="radiogroup" aria-label={t('one.funnel')}>
                        {funnels.map((funnel) => (
                          <button
                            key={funnel.id}
                            type="button"
                            role="radio"
                            aria-checked={plan.funnelId === funnel.id}
                            className={styles.chip}
                            data-testid={`hire-funnel-${funnel.id}`}
                            onClick={() => set({ funnelId: funnel.id, funnelTemplate: null })}
                          >
                            <bdi dir="auto">{funnel.name}</bdi>
                          </button>
                        ))}
                      </div>
                    )}
                    {/*
                      Or start from a ready-made funnel: chosen here, created
                      only on the hire's "yes" (inactive - never the
                      workspace's default).
                    */}
                    {templates === 'forbidden' ? null : (
                      <>
                        <h4 className={styles.blockTitle}>{t('one.funnelTemplates')}</h4>
                        {templates === 'failed' ? (
                          <p className={styles.notice} data-testid="hire-templates-failed">
                            {t('one.funnelTemplatesFailed')}
                          </p>
                        ) : (
                          <>
                            <p className={styles.sub}>{t('one.funnelTemplatesLead')}</p>
                            <div
                              className={styles.templates}
                              role="radiogroup"
                              aria-label={t('one.funnelTemplates')}
                            >
                              {templates.map((template) => (
                                <button
                                  key={template.id}
                                  type="button"
                                  role="radio"
                                  aria-checked={plan.funnelTemplate === template.id}
                                  className={styles.job}
                                  data-testid={`hire-template-${template.id}`}
                                  onClick={() =>
                                    set({ funnelTemplate: template.id, funnelId: null })
                                  }
                                >
                                  <span className={styles.jobName}>{template.name}</span>
                                  <span className={styles.jobText}>{template.description}</span>
                                  <span className={styles.stages}>
                                    {template.stages.map((stage) => (
                                      <span key={stage.id} className={styles.stage}>
                                        {stage.label}
                                      </span>
                                    ))}
                                  </span>
                                </button>
                              ))}
                            </div>
                          </>
                        )}
                      </>
                    )}
                  </section>
                ) : null}
                {/* ★ H8b: the Profile tab's switch and words, reused. */}
                <div className={styles.switchRow}>
                  <span className={styles.blockTitle} id="hire-discloses-label">
                    {tp('disclose.title')}
                  </span>
                  <span className={styles.sub} data-testid="hire-discloses-says">
                    {plan.disclosesAi ? tp('disclose.on') : tp('disclose.off')}
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    className={styles.switch}
                    checked={plan.disclosesAi}
                    aria-labelledby="hire-discloses-label"
                    data-testid="hire-discloses"
                    onChange={(e) => set({ disclosesAi: e.target.checked })}
                  />
                </div>
              </>
            ) : step === 2 ? (
              <>
                <div>
                  <h3 className={styles.question}>{t('two.title')}</h3>
                  <p className={styles.sub}>{t('two.sub')}</p>
                  {/* Backend's rule, said before it surprises anyone. */}
                  <p className={styles.sub} data-testid="hire-later">
                    {t('two.later')}
                  </p>
                  {/* By design, said where the levels are offered (H8a). */}
                  <p className={styles.sub} data-testid="hire-stricter">
                    {t('two.stricter')}
                  </p>
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
                            Per-employee access (Backend 00c6c229): the server's
                            allowlist, held in the plan like every other choice
                            here until hiring is live, then sent on create.
                          */}
                          <label className={styles.mayUse}>
                            <span>{t('two.mayUse', { name: group.label ?? group.provider })}</span>
                            <input
                              type="checkbox"
                              role="switch"
                              className={styles.switch}
                              checked={plan.access.includes(group.provider)}
                              onChange={(e) =>
                                setPlan((p) => withAccess(p, group.provider!, e.target.checked))
                              }
                              data-testid={`hire-may-use-${group.provider}`}
                            />
                          </label>
                        </div>
                      )}
                      {group.provider !== null && failing.has(group.provider) ? (
                        <p
                          className={styles.groupNote}
                          data-testid={`hire-failing-${group.provider}`}
                        >
                          {t('two.failing', { name: group.label ?? group.provider })}
                        </p>
                      ) : null}
                      {group.provider !== null && !plan.access.includes(group.provider) ? (
                        <p className={styles.groupNote} data-testid={`hire-off-${group.provider}`}>
                          {t('two.offForIt', { name: group.label ?? group.provider })}
                        </p>
                      ) : null}
                      <ul className={styles.rows}>
                        {group.tools.map((tool) => (
                          <li
                            key={tool.toolName}
                            className={styles.row}
                            data-grantable={tool.grant ? String(tool.grant.grantable) : undefined}
                            data-testid={`hire-row-${tool.toolName}`}
                          >
                            <span className={styles.rowName}>
                              {tool.label}
                              {tool.grant && !tool.grant.grantable ? (
                                <span
                                  className={styles.rowState}
                                  data-testid={`hire-not-set-up-${tool.toolName}`}
                                >
                                  {t('two.notSetUp')}
                                </span>
                              ) : null}
                            </span>
                            {/*
                              ★ H8a: an integration action reaches it only when
                              given; a built-in needs nothing, so has no switch.
                            */}
                            {tool.grant ? (
                              <label className={styles.give}>
                                <span>{t('two.give')}</span>
                                <input
                                  type="checkbox"
                                  role="switch"
                                  className={styles.switch}
                                  checked={
                                    tool.grant.grantable && plan.grants[tool.toolName] === true
                                  }
                                  disabled={!tool.grant.grantable}
                                  title={tool.grant.grantable ? undefined : t('two.notSetUp')}
                                  aria-label={t('two.giveFor', { name: tool.label })}
                                  data-testid={`hire-give-${tool.toolName}`}
                                  onChange={(e) =>
                                    set({
                                      grants: { ...plan.grants, [tool.toolName]: e.target.checked },
                                    })
                                  }
                                />
                              </label>
                            ) : null}
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
                                /*
                                  H5: within the ceiling, and never looser than
                                  the business has it - an employee's level is
                                  the same or stricter (the route's 422).
                                */
                                const offered = allowedChoices(tool).includes(choice);
                                const why = !tool.choices.includes(choice)
                                  ? t('two.ceiling')
                                  : offered
                                    ? undefined
                                    : t('two.looser', {
                                        current: t(`two.choice.${tool.current}`),
                                      });
                                return (
                                  <button
                                    key={choice}
                                    type="button"
                                    role="radio"
                                    aria-checked={plan.choices[tool.toolName] === choice}
                                    disabled={!offered}
                                    title={why}
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
                {/*
                  ★ H3 (Omer, 2026-10-13): handoff has real weight - its own
                  section, the conditions as a list to add, reword, switch and
                  remove, in the employee page's own editor. The chips stay,
                  as quick adds.
                */}
                <section className={styles.handover} data-testid="hire-handover">
                  <h4 className={styles.blockTitle}>{t('two.handover')}</h4>
                  <p className={styles.sub}>{tp('handover.lead')}</p>
                  <HandoverRules
                    id="hire"
                    rules={plan.rules}
                    onChange={(rules) => set({ rules })}
                  />
                  {suggestions.length > 0 && plan.rules.length < MAX_RULES ? (
                    <div className={styles.suggest} data-testid="hire-suggestions">
                      <span className={styles.suggestLabel}>{t('two.suggest')}</span>
                      {suggestions.map((h) => (
                        <button
                          key={h}
                          type="button"
                          className={styles.chip}
                          data-testid={`hire-handover-${h}`}
                          onClick={() =>
                            set({
                              rules: [...plan.rules, { label: t(`two.when.${h}`), enabled: true }],
                            })
                          }
                        >
                          {t(`two.when.${h}`)}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </section>
              </>
            ) : step === 3 ? (
              <>
                {/*
                  ★ H4 (Omer, 2026-10-13): what it reads and which skills it
                  carries, chosen before the summary. Knowledge is the
                  employee page's rule (`knowledge-plan.ts`) for one with no
                  id yet: a source every employee reads has no switch.
                */}
                <div>
                  <h3 className={styles.question}>{t('three.title')}</h3>
                  <p className={styles.sub}>{t('three.sub')}</p>
                </div>
                <section className={styles.group} data-testid="hire-knowledge">
                  <div className={styles.groupHead}>
                    <h4 className={styles.groupName}>{tk('title')}</h4>
                  </div>
                  <p className={styles.groupNote}>{t('three.knowledgeLead')}</p>
                  {knowledge === null ? (
                    <p className={styles.groupNote} data-testid="hire-knowledge-unread">
                      {t('three.knowledgeUnread')}
                    </p>
                  ) : knowledge.length === 0 ? (
                    <p className={styles.groupNone} data-testid="hire-knowledge-none">
                      {tk('none')}{' '}
                      <Link href="/studio/knowledge" className={page.link}>
                        {tk('manage')}
                      </Link>
                    </p>
                  ) : (
                    <ul className={styles.rows}>
                      {knowledge.map((source) => {
                        const attached = new Set(plan.knowledge);
                        const reach = reachOf(source, NEW_HIRE, attached);
                        const name = source.name || humaniseCode(source.id);
                        return (
                          <li
                            key={source.id}
                            className={styles.row}
                            data-testid={`hire-knows-${source.id}`}
                            data-reach={reach}
                          >
                            <span className={styles.rowName}>
                              <bdi dir="auto">{name}</bdi>
                              <span className={styles.rowState}>{tk(`reach.${reach}`)}</span>
                            </span>
                            {reachedByScope(source, NEW_HIRE) ? null : (
                              <input
                                type="checkbox"
                                role="switch"
                                className={styles.switch}
                                checked={attached.has(source.id)}
                                aria-label={tk('connect', { source: name })}
                                data-testid={`hire-knows-${source.id}-on`}
                                onChange={(e) =>
                                  set({
                                    knowledge: toggleIn(
                                      plan.knowledge,
                                      source.id,
                                      e.target.checked,
                                    ),
                                  })
                                }
                              />
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
                <section className={styles.group} data-testid="hire-skills">
                  <div className={styles.groupHead}>
                    <h4 className={styles.groupName}>{t('three.skills')}</h4>
                  </div>
                  <p className={styles.groupNote}>{t('three.skillsLead')}</p>
                  {skills === null ? (
                    <p className={styles.groupNote} data-testid="hire-skills-unread">
                      {t('three.skillsUnread')}
                    </p>
                  ) : skills.length === 0 ? (
                    <p className={styles.groupNone} data-testid="hire-skills-none">
                      {t('three.skillsNone')}{' '}
                      <Link href="/studio/skills" className={page.link}>
                        {t('three.skillsWrite')}
                      </Link>
                    </p>
                  ) : (
                    <ul className={styles.rows}>
                      {skills.map((skill) => (
                        <li
                          key={skill.id}
                          className={styles.row}
                          data-testid={`hire-skill-${skill.id}`}
                        >
                          <span className={styles.rowName}>
                            <bdi dir="auto">{skill.name}</bdi>
                            {skill.status === 'draft' ? (
                              <span className={styles.rowState}>{t('three.skillDraft')}</span>
                            ) : skill.situation ? (
                              <span className={styles.rowState}>
                                <bdi dir="auto">{skill.situation}</bdi>
                              </span>
                            ) : null}
                          </span>
                          <input
                            type="checkbox"
                            role="switch"
                            className={styles.switch}
                            checked={plan.skills.includes(skill.id)}
                            aria-label={t('three.carry', { name: skill.name })}
                            data-testid={`hire-skill-${skill.id}-on`}
                            onChange={(e) =>
                              set({ skills: toggleIn(plan.skills, skill.id, e.target.checked) })
                            }
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </>
            ) : (
              <>
                {/*
                  ★ H4: the summary replaces the trial - the whole employee,
                  each part with an Edit back to its step. ★ H5: its only
                  action is the hire, asked before it runs.
                */}
                <div>
                  <h3 className={styles.question}>{t('four.title')}</h3>
                  <p className={styles.sub}>{t('four.sub')}</p>
                </div>
                {(
                  [
                    ['profile', 1],
                    ['limits', 2],
                    ['handover', 2],
                    ['knowledge', 3],
                    ['skills', 3],
                  ] as const
                ).map(([part, to]) => (
                  <section key={part} className={styles.summary} data-testid={`hire-sum-${part}`}>
                    <div className={styles.summaryHead}>
                      <h4 className={styles.blockTitle}>{t(`four.part.${part}`)}</h4>
                      <button
                        type="button"
                        className={styles.edit}
                        aria-label={t('four.editFor', { part: t(`four.part.${part}`) })}
                        data-testid={`hire-edit-${part}`}
                        onClick={() => go(to)}
                      >
                        {t('four.edit')}
                      </button>
                    </div>
                    {part === 'profile' ? (
                      <dl className={styles.pairs}>
                        <dt>{t('four.job')}</dt>
                        <dd data-testid="hire-sum-job">
                          {plan.job ? t(`job.${plan.job}.name`) : null}
                        </dd>
                        <dt>{t('four.goal')}</dt>
                        <dd data-testid="hire-sum-goal">
                          <bdi dir="auto">{goal}</bdi>
                        </dd>
                        <dt>{t('four.name')}</dt>
                        <dd data-testid="hire-sum-name">
                          <bdi dir="auto">{plan.name.trim()}</bdi>
                        </dd>
                        {needsFunnel(plan.job) ? (
                          <>
                            <dt>{t('one.funnel')}</dt>
                            <dd data-testid="hire-sum-funnel">
                              {funnelName ? <bdi dir="auto">{funnelName}</bdi> : t('four.none')}
                            </dd>
                          </>
                        ) : null}
                        <dt>{tp('disclose.title')}</dt>
                        <dd data-testid="hire-sum-discloses">
                          {plan.disclosesAi ? tp('disclose.on') : tp('disclose.off')}
                        </dd>
                      </dl>
                    ) : part === 'limits' ? (
                      <dl className={styles.pairs}>
                        <dt>{t('four.actions')}</dt>
                        <dd data-testid="hire-sum-actions">
                          {tools.length === 0
                            ? t('two.noTools')
                            : t('four.counts', {
                                doIt: tools.filter((x) => plan.choices[x.toolName] === 'do_it')
                                  .length,
                                askMe: tools.filter((x) => plan.choices[x.toolName] === 'ask_me')
                                  .length,
                                never: tools.filter((x) => plan.choices[x.toolName] === 'never')
                                  .length,
                              })}
                        </dd>
                        <dt>{t('four.given')}</dt>
                        <dd data-testid="hire-sum-given">
                          {given.length === 0
                            ? t('four.none')
                            : given.map((tool, i) => (
                                <span key={tool.toolName}>
                                  {i > 0 ? ', ' : null}
                                  {tool.providerLabel
                                    ? `${tool.providerLabel} · ${tool.label}`
                                    : tool.label}
                                </span>
                              ))}
                        </dd>
                        <dt>{t('four.systems')}</dt>
                        <dd data-testid="hire-sum-systems">
                          {plan.access.length === 0
                            ? t('four.none')
                            : plan.access.map((key, i) => (
                                <span key={key}>
                                  {i > 0 ? ', ' : null}
                                  <bdi dir="auto">{systemName(key)}</bdi>
                                </span>
                              ))}
                        </dd>
                      </dl>
                    ) : part === 'handover' ? (
                      plan.rules.length === 0 ? (
                        <p className={styles.summaryNone}>{tp('handover.none')}</p>
                      ) : (
                        <ul className={styles.summaryList} data-testid="hire-sum-rules">
                          {plan.rules.map((rule, i) => (
                            <li key={i}>
                              <bdi dir="auto">{rule.label.trim()}</bdi>
                              {rule.enabled ? null : (
                                <span className={styles.rowState}> {t('four.off')}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )
                    ) : part === 'knowledge' ? (
                      connected.length === 0 ? (
                        <p className={styles.summaryNone}>{t('four.none')}</p>
                      ) : (
                        <ul className={styles.summaryList} data-testid="hire-sum-knows">
                          {connected.map((id) => {
                            const source = knowledge?.find((k) => k.id === id);
                            return (
                              <li key={id}>
                                <bdi dir="auto">{source?.name || humaniseCode(id)}</bdi>
                              </li>
                            );
                          })}
                        </ul>
                      )
                    ) : carried.length === 0 ? (
                      <p className={styles.summaryNone}>{t('four.none')}</p>
                    ) : (
                      <>
                        <ul className={styles.summaryList} data-testid="hire-sum-skill-names">
                          {carried.map((id) => (
                            <li key={id}>
                              <bdi dir="auto">
                                {skills?.find((x) => x.id === id)?.name ?? humaniseCode(id)}
                              </bdi>
                            </li>
                          ))}
                        </ul>
                        <p className={styles.summaryNone}>{t('four.watch')}</p>
                      </>
                    )}
                  </section>
                ))}
                {blocks.length > 0 ? (
                  <div className={styles.notice} data-testid="hire-blocked">
                    <p className={styles.noticeTitle}>{t('four.blocked')}</p>
                    <ul className={styles.summaryList}>
                      {blocks.map((block) => (
                        <li key={block} data-testid={`hire-block-${block}`}>
                          {t(`four.block.${block}`)}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {failed ? (
                  <div className={styles.failed} role="alert" data-testid="hire-failed">
                    <p className={styles.noticeTitle}>
                      {failed.id === null && failed.reason !== 'gone'
                        ? t('failed.nothing')
                        : t('failed.notHired')}{' '}
                      {t(`failed.reason.${failed.reason}`)}
                    </p>
                    {failed.id !== null ? (
                      <>
                        <p>{t('failed.saved')}</p>
                        <ul className={styles.summaryList} data-testid="hire-failed-saved">
                          {failed.saved.map((w) => (
                            <li key={w}>{t(`failed.write.${w}`)}</li>
                          ))}
                          {failed.failed === 'grants' && failed.grants.saved > 0 ? (
                            <li>{t('failed.grantsPart', failed.grants)}</li>
                          ) : null}
                          {failed.failed === 'levels' && failed.levels.saved > 0 ? (
                            <li>{t('failed.levelsPart', failed.levels)}</li>
                          ) : null}
                        </ul>
                      </>
                    ) : null}
                    {failed.id !== null ? (
                      <>
                        <p>{t('failed.notSaved')}</p>
                        <ul className={styles.summaryList} data-testid="hire-failed-not-saved">
                          {writesOf(requestOf())
                            .filter((w: HireWrite) => !failed.saved.includes(w))
                            .map((w) => (
                              <li key={w}>{t(`failed.write.${w}`)}</li>
                            ))}
                        </ul>
                        <p data-testid="hire-failed-kept">{t('failed.kept')}</p>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}

            <footer className={styles.foot}>
              {step === 4 ? (
                confirming ? (
                  <div className={styles.confirm} role="alertdialog" data-testid="hire-confirm">
                    <span className={styles.confirmAsk}>{t('confirm.ask')}</span>
                    <button
                      type="button"
                      className={styles.primary}
                      disabled={hiring}
                      data-testid="hire-confirm-yes"
                      onClick={hire}
                    >
                      {hiring ? t('four.hiring') : t('confirm.yes')}
                    </button>
                    <button
                      type="button"
                      className={styles.quiet}
                      disabled={hiring}
                      data-testid="hire-confirm-no"
                      onClick={() => setConfirming(false)}
                    >
                      {t('confirm.no')}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className={styles.primary}
                    disabled={blocks.length > 0 || hiring}
                    data-testid="hire-it"
                    onClick={() => setConfirming(true)}
                  >
                    {t('four.hire')}
                  </button>
                )
              ) : (
                <button
                  type="button"
                  className={styles.primary}
                  disabled={
                    (step === 1 && !stepOneDone(plan)) ||
                    (step === 2 && rulesProblem(plan.rules) !== null)
                  }
                  data-testid="hire-continue"
                  onClick={() => go((step + 1) as Step)}
                >
                  {t('continue')}
                </button>
              )}
              {confirming ? null : step === 1 ? (
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
              {confirming ? null : (
                <span className={styles.footNote}>
                  {t(step === 4 ? 'note.summary' : 'note.before')}
                </span>
              )}
            </footer>
          </div>

          <aside className={styles.side}>
            {step === 2 ? (
              <>
                <h4 className={styles.eyebrow}>{t('side.cost')}</h4>
                {/* Nothing estimates it yet: said, never a dash before a unit. */}
                <p className={styles.sideLead} data-testid="hire-cost">
                  {t('side.costNone')}
                </p>
              </>
            ) : (
              <>
                <h4 className={styles.eyebrow}>{t('side.dayOne')}</h4>
                <p className={styles.sideLead} data-testid="hire-day-one">
                  {plan.job ? <bdi dir="auto">{goal || t(`job.${plan.job}.dayOne`)}</bdi> : '-'}
                </p>
                {step === 1 ? (
                  <>
                    <h4 className={styles.sideLabel}>{t('side.knows')}</h4>
                    {knowledge && knowledge.some((k) => k.isActive && k.name) ? (
                      <ul className={styles.sideList} data-testid="hire-knows">
                        {knowledge
                          .filter((k) => k.isActive && k.name)
                          .slice(0, 4)
                          .map((k) => (
                            <li key={k.id}>
                              <bdi dir="auto">{k.name}</bdi>
                            </li>
                          ))}
                      </ul>
                    ) : (
                      <p className={styles.none} title={t('side.knowsNone')}>
                        -
                      </p>
                    )}
                  </>
                ) : null}
              </>
            )}
            <p className={styles.sideNext}>{t(`side.next.${step}`)}</p>
          </aside>
        </div>
      </section>
    </div>
  );
}
