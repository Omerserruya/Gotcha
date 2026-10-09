'use client';

import { GripVertical, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type DragEvent, type KeyboardEvent } from 'react';

import {
  RULE_TYPES,
  SKILL_CATEGORIES,
  SKILL_LIMITS,
  STEP_KINDS,
  type StepKind,
  type ToolChoice,
} from '@/api/contracts/skills';

import { moveStep, newStep, type DraftStep, type SkillDraft } from './skill-draft';
import { ToolMark, toolLabel } from './ToolChip';
import styles from './SkillForm.module.css';

/**
 * The skill, written - 09b's blocks and 21's, one form (design 6).
 *
 *   When to use it   the description, "Sounds like" phrases, "Not for" → another skill
 *   Steps            numbered, draggable (and movable by keyboard); each a
 *                    title, a kind, its tools, guidance, "Asks you first over
 *                    X", and what to do otherwise
 *   Rules            Never / Hand over - they override the steps
 *
 * ★ Tools are the tenant's own list (`/business-skills/tools`). One that is
 *   not connected or not allowed is listed and disabled with its reason: a
 *   skill never grants a tool, and a step that needs a missing one is where
 *   the employee will hand over.
 *
 * `errors` is keyed by Backend's own field paths (`steps[0].title`), so its
 * 422 lands at the same field as our own checks.
 */
export function SkillForm({
  draft,
  onChange,
  tools,
  otherSkills,
  errors,
  newId,
}: {
  readonly draft: SkillDraft;
  readonly onChange: (next: SkillDraft) => void;
  /** `null`: the tool list could not be read - steps keep their tools, and say so. */
  readonly tools: readonly ToolChoice[] | null;
  readonly otherSkills: readonly { readonly id: string; readonly name: string }[];
  readonly errors: ReadonlyMap<string, string>;
  /** Mints a step id - in a handler, never during render. */
  readonly newId: () => string;
}) {
  const t = useTranslations('skills.form');
  const [example, setExample] = useState('');
  const [dragging, setDragging] = useState<number | null>(null);
  /** Steps whose "Asks you first over" field was opened by its link. */
  const [amountOpen, setAmountOpen] = useState<ReadonlySet<string>>(new Set());
  const set = <K extends keyof SkillDraft>(key: K, value: SkillDraft[K]) =>
    onChange({ ...draft, [key]: value });
  const setStep = (index: number, step: Partial<DraftStep>) =>
    set(
      'steps',
      draft.steps.map((s, i) => (i === index ? { ...s, ...step } : s)),
    );
  /* "Shopify · Find order" - the brand's spelling, the action in sentence case (`toolLabel`). */
  const toolName = (name: string, step?: DraftStep) => {
    const detail = step?.toolDetails.find((d) => d.name === name) ?? null;
    const { provider, action } = toolLabel(name, tools, detail);
    return provider ? `${provider} · ${action}` : action;
  };

  const addExample = () => {
    const words = example.trim();
    if (!words || draft.examples.length >= SKILL_LIMITS.list) return;
    set('examples', [...draft.examples, words]);
    setExample('');
  };

  const onDrop = (event: DragEvent, to: number) => {
    event.preventDefault();
    if (dragging !== null) set('steps', moveStep(draft.steps, dragging, to));
    setDragging(null);
  };

  return (
    <div className={styles.form}>
      <section className={styles.card} aria-labelledby="skill-when">
        <h2 className={styles.eyebrow} id="skill-when">
          {t('when')}
        </h2>
        <div className={styles.identity}>
          <Field label={t('name')} error={errors.get('name')}>
            <input
              className={styles.input}
              value={draft.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder={t('namePlaceholder')}
              data-testid="skill-name"
              data-field="name"
            />
          </Field>
          <Field label={t('situation')} error={errors.get('situation')}>
            <input
              className={styles.input}
              value={draft.situation}
              onChange={(e) => set('situation', e.target.value)}
              placeholder={t('situationPlaceholder')}
              data-testid="skill-situation"
            />
          </Field>
          <Field label={t('category')}>
            <select
              className={styles.input}
              value={draft.category}
              onChange={(e) => set('category', e.target.value as SkillDraft['category'])}
              data-testid="skill-category"
            >
              {SKILL_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(`categories.${c}`)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label={t('whenLabel')} error={errors.get('whenToUse')} hiddenLabel>
          <textarea
            className={styles.lead}
            rows={2}
            value={draft.whenToUse}
            onChange={(e) => set('whenToUse', e.target.value)}
            placeholder={t('whenPlaceholder')}
            data-testid="skill-when"
          />
        </Field>

        <div className={styles.line}>
          <span className={styles.lineLabel}>{t('soundsLike')}</span>
          <ul className={styles.chips} data-testid="skill-examples">
            {draft.examples.map((e, i) => (
              <li key={`${i}-${e}`} className={styles.example}>
                <bdi dir="auto">{e}</bdi>
                <button
                  type="button"
                  className={styles.chipRemove}
                  aria-label={t('remove', { what: e })}
                  onClick={() =>
                    set(
                      'examples',
                      draft.examples.filter((_, j) => j !== i),
                    )
                  }
                >
                  <X size={11} aria-hidden="true" />
                </button>
              </li>
            ))}
            <li>
              <input
                className={styles.chipInput}
                value={example}
                onChange={(e) => setExample(e.target.value)}
                onKeyDown={(e: KeyboardEvent) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addExample();
                  }
                }}
                onBlur={addExample}
                placeholder={t('examplePlaceholder')}
                aria-label={t('soundsLike')}
                data-testid="skill-example-input"
              />
            </li>
          </ul>
        </div>
        {errors.get('examples') ? <p className={styles.error}>{errors.get('examples')}</p> : null}
        <p className={styles.hint}>{t('meaningNotKeywords')}</p>

        <div className={styles.line}>
          <span className={styles.lineLabel}>{t('notFor')}</span>
          <ul className={styles.exclusions} data-testid="skill-exclusions">
            {draft.exclusions.map((x, i) => (
              <li key={i} className={styles.exclusion}>
                <input
                  className={styles.inlineInput}
                  value={x.text}
                  onChange={(e) =>
                    set(
                      'exclusions',
                      draft.exclusions.map((y, j) =>
                        j === i ? { ...y, text: e.target.value } : y,
                      ),
                    )
                  }
                  placeholder={t('notForPlaceholder')}
                  aria-label={t('notFor')}
                />
                <span aria-hidden="true">→</span>
                <select
                  className={styles.inlineSelect}
                  value={x.skillId ?? ''}
                  onChange={(e) =>
                    set(
                      'exclusions',
                      draft.exclusions.map((y, j) =>
                        j === i ? { ...y, skillId: e.target.value || null } : y,
                      ),
                    )
                  }
                  aria-label={t('notForSkill')}
                >
                  <option value="">{t('notForNoSkill')}</option>
                  {otherSkills.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className={styles.chipRemove}
                  aria-label={t('remove', { what: x.text })}
                  onClick={() =>
                    set(
                      'exclusions',
                      draft.exclusions.filter((_, j) => j !== i),
                    )
                  }
                >
                  <X size={11} aria-hidden="true" />
                </button>
              </li>
            ))}
            <li>
              <button
                type="button"
                className={styles.add}
                disabled={draft.exclusions.length >= SKILL_LIMITS.list}
                onClick={() =>
                  set('exclusions', [...draft.exclusions, { text: '', skillId: null }])
                }
                data-testid="skill-add-exclusion"
              >
                {t('addNotFor')}
              </button>
            </li>
          </ul>
        </div>
      </section>

      <section className={styles.card} aria-labelledby="skill-steps">
        <h2 className={styles.eyebrow} id="skill-steps">
          {t('steps')}
        </h2>
        {tools === null ? <p className={styles.hint}>{t('toolsUnread')}</p> : null}
        {errors.get('steps') ? <p className={styles.error}>{errors.get('steps')}</p> : null}
        <ol className={styles.steps} data-testid="skill-steps">
          {draft.steps.map((step, i) => (
            <li
              key={step.id}
              className={styles.step}
              data-testid={`skill-step-${i}`}
              data-dragging={dragging === i ? '' : undefined}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => onDrop(e, i)}
            >
              <span className={styles.number} aria-hidden="true">
                {i + 1}
              </span>
              <div className={styles.stepBody}>
                <div className={styles.stepTop}>
                  <input
                    className={styles.stepTitle}
                    value={step.title}
                    onChange={(e) => setStep(i, { title: e.target.value })}
                    placeholder={t('stepTitlePlaceholder')}
                    aria-label={t('stepTitle', { n: i + 1 })}
                    data-field={`steps[${i}].title`}
                    data-testid={`skill-step-title-${i}`}
                  />
                  <select
                    className={styles.kind}
                    value={step.kind}
                    onChange={(e) => setStep(i, { kind: e.target.value as StepKind })}
                    aria-label={t('stepKind', { n: i + 1 })}
                    data-testid={`skill-step-kind-${i}`}
                  >
                    {STEP_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {t(`kinds.${k}`)}
                      </option>
                    ))}
                  </select>
                </div>
                {errors.get(`steps[${i}].title`) ? (
                  <p className={styles.error}>{errors.get(`steps[${i}].title`)}</p>
                ) : null}
                {errors.get(`steps[${i}].kind`) ? (
                  <p className={styles.error}>{errors.get(`steps[${i}].kind`)}</p>
                ) : null}

                <ul className={styles.chips}>
                  {step.tools.map((name) => (
                    <li key={name} className={styles.tool}>
                      <ToolMark
                        name={name}
                        slug={
                          toolLabel(
                            name,
                            tools,
                            step.toolDetails.find((d) => d.name === name),
                          ).slug
                        }
                      />
                      {toolName(name, step)}
                      <button
                        type="button"
                        className={styles.chipRemove}
                        aria-label={t('remove', { what: toolName(name) })}
                        onClick={() => setStep(i, { tools: step.tools.filter((x) => x !== name) })}
                      >
                        <X size={11} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                  {tools && step.tools.length < SKILL_LIMITS.toolsPerStep ? (
                    <li>
                      <select
                        className={styles.addTool}
                        value=""
                        onChange={(e) => {
                          if (e.target.value)
                            setStep(i, { tools: [...step.tools, e.target.value] });
                        }}
                        aria-label={t('addTool', { n: i + 1 })}
                        data-testid={`skill-step-add-tool-${i}`}
                      >
                        <option value="">{t('addToolOption')}</option>
                        {tools
                          .filter((tool) => !step.tools.includes(tool.name))
                          .map((tool) => (
                            <option
                              key={tool.name}
                              value={tool.name}
                              disabled={!tool.connected || tool.allowedForAgent === false}
                            >
                              {toolName(tool.name)}
                              {tool.reason ? ` - ${t(`toolReasons.${tool.reason}`)}` : ''}
                            </option>
                          ))}
                      </select>
                    </li>
                  ) : null}
                  {errors.get(`steps[${i}].tools`) ? (
                    <li className={styles.error}>{errors.get(`steps[${i}].tools`)}</li>
                  ) : null}
                </ul>

                <textarea
                  className={styles.guidance}
                  rows={1}
                  value={step.guidance}
                  onChange={(e) => setStep(i, { guidance: e.target.value })}
                  placeholder={t('guidancePlaceholder')}
                  aria-label={t('guidance', { n: i + 1 })}
                />
                <div className={styles.stepExtras}>
                  {/*
                    A chip when there is a threshold ("Asks you first over 200"); a
                    small link to add one when there is not (dev: an empty field on
                    every step was weight).
                  */}
                  {step.approvalOver.trim() || amountOpen.has(step.id) ? (
                    <label className={styles.approval}>
                      <span>{t('asksOver')}</span>
                      <input
                        className={styles.amount}
                        inputMode="decimal"
                        value={step.approvalOver}
                        onChange={(e) => setStep(i, { approvalOver: e.target.value })}
                        // Opened by its link: the cursor goes straight in.
                        autoFocus={amountOpen.has(step.id) && !step.approvalOver}
                        data-testid={`skill-step-amount-${i}`}
                      />
                    </label>
                  ) : (
                    <button
                      type="button"
                      className={styles.add}
                      onClick={() => setAmountOpen(new Set(amountOpen).add(step.id))}
                      data-testid={`skill-step-add-amount-${i}`}
                    >
                      {t('addAmount')}
                    </button>
                  )}
                  <input
                    className={styles.elseNote}
                    value={step.elseNote}
                    onChange={(e) => setStep(i, { elseNote: e.target.value })}
                    placeholder={t('elsePlaceholder')}
                    aria-label={t('elseLabel', { n: i + 1 })}
                  />
                </div>
                {errors.get(`steps[${i}].approvalOverAmount`) ? (
                  <p className={styles.error}>{errors.get(`steps[${i}].approvalOverAmount`)}</p>
                ) : null}
              </div>
              <div className={styles.stepControls}>
                <span
                  className={styles.grip}
                  draggable
                  onDragStart={() => setDragging(i)}
                  onDragEnd={() => setDragging(null)}
                  aria-hidden="true"
                  title={t('drag')}
                >
                  <GripVertical size={14} />
                </span>
                <button
                  type="button"
                  className={styles.iconButton}
                  disabled={i === 0}
                  onClick={() => set('steps', moveStep(draft.steps, i, i - 1))}
                  aria-label={t('moveUp', { n: i + 1 })}
                  data-testid={`skill-step-up-${i}`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className={styles.iconButton}
                  disabled={i === draft.steps.length - 1}
                  onClick={() => set('steps', moveStep(draft.steps, i, i + 1))}
                  aria-label={t('moveDown', { n: i + 1 })}
                  data-testid={`skill-step-down-${i}`}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className={styles.iconButton}
                  onClick={() =>
                    set(
                      'steps',
                      draft.steps.filter((_, j) => j !== i),
                    )
                  }
                  aria-label={t('removeStep', { n: i + 1 })}
                  data-testid={`skill-step-remove-${i}`}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
        </ol>
        <p className={styles.addStep}>
          <span>{t('addStep')}</span>
          {STEP_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              className={styles.add}
              disabled={draft.steps.length >= SKILL_LIMITS.steps}
              onClick={() => set('steps', [...draft.steps, newStep(kind, newId())])}
              data-testid={`skill-add-step-${kind}`}
            >
              {t(`kinds.${kind}`)}
            </button>
          ))}
        </p>
      </section>

      <section className={styles.card} aria-labelledby="skill-rules">
        <h2 className={styles.eyebrow} id="skill-rules">
          {t('rules')}
        </h2>
        <ul className={styles.rules} data-testid="skill-rules">
          {draft.rules.map((rule, i) => (
            <li key={i} className={styles.rule}>
              <select
                className={styles.ruleType}
                data-type={rule.type}
                value={rule.type}
                onChange={(e) =>
                  set(
                    'rules',
                    draft.rules.map((r, j) =>
                      j === i ? { ...r, type: e.target.value as typeof rule.type } : r,
                    ),
                  )
                }
                aria-label={t('ruleType', { n: i + 1 })}
              >
                {RULE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`ruleTypes.${type}`)}
                  </option>
                ))}
              </select>
              <input
                className={styles.inlineInput}
                value={rule.text}
                onChange={(e) =>
                  set(
                    'rules',
                    draft.rules.map((r, j) => (j === i ? { ...r, text: e.target.value } : r)),
                  )
                }
                placeholder={t(`rulePlaceholders.${rule.type}`)}
                aria-label={t('ruleText', { n: i + 1 })}
              />
              <button
                type="button"
                className={styles.chipRemove}
                aria-label={t('remove', { what: rule.text })}
                onClick={() =>
                  set(
                    'rules',
                    draft.rules.filter((_, j) => j !== i),
                  )
                }
              >
                <X size={11} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
        <p className={styles.addStep}>
          {RULE_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              className={styles.add}
              disabled={draft.rules.length >= SKILL_LIMITS.list}
              onClick={() => set('rules', [...draft.rules, { type, text: '' }])}
              data-testid={`skill-add-rule-${type}`}
            >
              {t(`addRule.${type}`)}
            </button>
          ))}
        </p>
        <p className={styles.hint}>{t('rulesOverride')}</p>
      </section>
    </div>
  );
}

function Field({
  label,
  error,
  hiddenLabel = false,
  children,
}: {
  readonly label: string;
  readonly error?: string;
  readonly hiddenLabel?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <label className={styles.field}>
      <span className={hiddenLabel ? 'srOnly' : styles.fieldLabel}>{label}</span>
      {children}
      {error ? <span className={styles.error}>{error}</span> : null}
    </label>
  );
}
