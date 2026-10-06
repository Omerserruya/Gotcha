import {
  SKILL_LIMITS,
  type RuleType,
  type Skill,
  type SkillCategory,
  type StepKind,
} from '@/api/contracts/skills';

/**
 * What the skill form edits - 21 (new) and 09b (edit) alike. Plain values,
 * so a step's id travels with it: Backend needs the ids back on every PUT,
 * or a run in progress loses its step.
 */
export interface DraftStep {
  readonly id: string;
  readonly kind: StepKind;
  readonly title: string;
  readonly guidance: string;
  readonly tools: readonly string[];
  /** As typed; '' is "no threshold". */
  readonly approvalOver: string;
  readonly elseNote: string;
}

export interface SkillDraft {
  readonly name: string;
  readonly situation: string;
  readonly category: SkillCategory;
  readonly whenToUse: string;
  readonly examples: readonly string[];
  readonly exclusions: readonly { readonly text: string; readonly skillId: string | null }[];
  readonly steps: readonly DraftStep[];
  readonly rules: readonly { readonly type: RuleType; readonly text: string }[];
  readonly requiredInfo: Skill['requiredInfo'];
}

export function blankDraft(): SkillDraft {
  return {
    name: '',
    situation: '',
    category: 'other',
    whenToUse: '',
    examples: [],
    exclusions: [],
    steps: [],
    rules: [],
    requiredInfo: [],
  };
}

export function draftOf(skill: Skill): SkillDraft {
  return {
    name: skill.name,
    situation: skill.situation ?? '',
    category: skill.category,
    whenToUse: skill.whenToUse ?? '',
    examples: skill.examples,
    exclusions: skill.exclusions,
    steps: skill.steps.map((s) => ({
      id: s.id,
      kind: s.kind,
      title: s.title,
      guidance: s.guidance,
      tools: s.tools,
      approvalOver: s.approvalOverAmount === null ? '' : String(s.approvalOverAmount),
      elseNote: s.elseNote ?? '',
    })),
    rules: skill.rules,
    requiredInfo: skill.requiredInfo,
  };
}

/** A new step of a kind, its id minted by the caller (in a handler, never in render). */
export function newStep(kind: StepKind, id: string): DraftStep {
  return { id, kind, title: '', guidance: '', tools: [], approvalOver: '', elseNote: '' };
}

/** Move the step at `from` to `to`, keeping every id. */
export function moveStep(steps: readonly DraftStep[], from: number, to: number): DraftStep[] {
  const next = [...steps];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length) return next;
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/** A problem the form can name before asking Backend, at a field Backend would name too. */
export interface DraftProblem {
  /** Backend's own field path, e.g. `steps[0].title`. */
  readonly field: string;
  readonly code:
    | 'name_required'
    | 'step_title_required'
    | 'too_many_steps'
    | 'too_many_tools'
    | 'too_many_items'
    | 'amount_invalid';
}

export function draftProblems(draft: SkillDraft): DraftProblem[] {
  const problems: DraftProblem[] = [];
  if (!draft.name.trim()) problems.push({ field: 'name', code: 'name_required' });
  if (draft.steps.length > SKILL_LIMITS.steps)
    problems.push({ field: 'steps', code: 'too_many_steps' });
  draft.steps.forEach((s, i) => {
    if (!s.title.trim()) problems.push({ field: `steps[${i}].title`, code: 'step_title_required' });
    if (s.tools.length > SKILL_LIMITS.toolsPerStep)
      problems.push({ field: `steps[${i}].tools`, code: 'too_many_tools' });
    if (s.approvalOver.trim() && !(Number(s.approvalOver) >= 0))
      problems.push({ field: `steps[${i}].approvalOverAmount`, code: 'amount_invalid' });
  });
  for (const key of ['examples', 'exclusions', 'rules', 'requiredInfo'] as const) {
    if (draft[key].length > SKILL_LIMITS.list)
      problems.push({ field: key, code: 'too_many_items' });
  }
  return problems;
}

/** The body of a POST or PUT: every field, trimmed, empty optional text as `null`. */
export function bodyOf(draft: SkillDraft) {
  const text = (value: string) => (value.trim() ? value.trim() : null);
  return {
    name: draft.name.trim(),
    situation: text(draft.situation),
    category: draft.category,
    whenToUse: text(draft.whenToUse),
    examples: draft.examples.map((e) => e.trim()).filter(Boolean),
    exclusions: draft.exclusions
      .map((e) => ({ text: e.text.trim(), skillId: e.skillId }))
      .filter((e) => e.text),
    steps: draft.steps.map((s) => ({
      id: s.id,
      kind: s.kind,
      title: s.title.trim(),
      guidance: s.guidance.trim(),
      tools: s.tools,
      approvalOverAmount: s.approvalOver.trim() ? Number(s.approvalOver) : null,
      elseNote: text(s.elseNote),
    })),
    rules: draft.rules.map((r) => ({ type: r.type, text: r.text.trim() })).filter((r) => r.text),
    requiredInfo: draft.requiredInfo,
  };
}
export type SkillBody = ReturnType<typeof bodyOf>;
