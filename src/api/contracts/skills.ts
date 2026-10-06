import { z } from 'zod';

/**
 * Business skills - the tenant's own procedures for one situation (plan
 * §3.1; Backend b9278d7e). `/api/ai-skills` is a different thing - the
 * SYSTEM skills catalogue - and is not read here.
 *
 * Strict envelopes throughout: until the routes are deployed (nginx location
 * pending, 2026-10-06), every read here is "couldn't read", never an empty
 * library.
 */

export const SKILL_CATEGORIES = ['orders', 'products', 'bookings', 'other'] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

export const STEP_KINDS = [
  'find',
  'check',
  'change',
  'document',
  'message',
  'approval',
  'handover',
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const SKILL_STATUSES = ['draft', 'active', 'archived'] as const;
export type SkillStatus = (typeof SKILL_STATUSES)[number];

export const SKILL_MODES = ['on', 'watch', 'off'] as const;
export type SkillMode = (typeof SKILL_MODES)[number];

export const RULE_TYPES = ['never', 'handover'] as const;
export type RuleType = (typeof RULE_TYPES)[number];

export const NO_SKILL_POLICIES = [
  'answer_from_knowledge',
  'always_handover',
  'knowledge_only',
] as const;
export type NoSkillPolicy = (typeof NO_SKILL_POLICIES)[number];

/** Backend's limits: more is a 422 `INVALID_SKILL`. */
export const SKILL_LIMITS = { steps: 20, toolsPerStep: 10, list: 20 } as const;

const nullableText = z.string().nullable().catch(null).default(null);

export const skillStepSchema = z.object({
  /** Sent back on every PUT: a run in progress keeps its place by it. */
  id: z.string().min(1),
  kind: z.enum(STEP_KINDS),
  title: z.string(),
  guidance: z.string().default(''),
  /** Tool names (`ToolChoice.name`). A skill never grants one (§3.2.7). */
  tools: z.array(z.string()).default([]),
  /** Only tightens approval: "Asks you first over X". */
  approvalOverAmount: z.number().nonnegative().nullable().catch(null).default(null),
  elseNote: nullableText,
});
export type SkillStep = z.infer<typeof skillStepSchema>;

export const skillStatsSchema = z.object({
  skillId: z.string().min(1),
  runs: z.number().int().nonnegative().catch(0),
  watchRuns: z.number().int().nonnegative().catch(0),
  /** Finished without a person, 0-1. `null`: nothing finished to divide by. */
  aloneShare: z.number().min(0).max(1).nullable().catch(null),
  askedYou: z.number().int().nonnegative().catch(0),
  stopReasons: z
    .array(z.object({ reason: z.string(), count: z.number().int().nonnegative().catch(0) }))
    .catch([])
    .default([]),
  usedBy: z
    .array(
      z.object({
        aiAgentId: z.string().min(1),
        name: z.string().catch(''),
        mode: z.enum(SKILL_MODES).catch('watch'),
        order: z.number().int().catch(0),
      }),
    )
    .catch([])
    .default([]),
});
export type SkillStats = z.infer<typeof skillStatsSchema>;

export const skillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** The situation in the customer's words - 09's subtitle. */
  situation: nullableText,
  category: z.enum(SKILL_CATEGORIES).catch('other'),
  whenToUse: nullableText,
  examples: z.array(z.string()).default([]),
  exclusions: z
    .array(z.object({ text: z.string(), skillId: z.string().nullable().catch(null).default(null) }))
    .default([]),
  steps: z.array(skillStepSchema).default([]),
  rules: z.array(z.object({ type: z.enum(RULE_TYPES), text: z.string() })).default([]),
  requiredInfo: z
    .array(z.object({ key: z.string(), label: z.string(), priority: z.number().catch(0) }))
    .default([]),
  status: z.enum(SKILL_STATUSES),
  version: z.number().int().nonnegative(),
  createdAt: nullableText,
  updatedAt: nullableText,
  archivedAt: nullableText,
  /** On the list and on one skill (`?from=`); absent on a POST's answer. */
  stats: skillStatsSchema.nullable().catch(null).default(null),
});
export type Skill = z.infer<typeof skillSchema>;

/* Strict on the envelope: an absent route's 404/HTML is "unread", not "no skills". */
export const skillsListSchema = z.object({ data: z.array(skillSchema) });
export const skillOneSchema = z.object({ data: skillSchema });

export const RUN_STATUSES = ['active', 'completed', 'handed_over', 'failed', 'abandoned'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const skillRunSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().nullable().catch(null).default(null),
  aiAgentId: z.string().nullable().catch(null).default(null),
  skillVersion: z.number().int().catch(0),
  mode: z.enum(['on', 'watch']).catch('on'),
  status: z.enum(RUN_STATUSES).catch('active'),
  currentStepId: nullableText,
  gatheredKeys: z.array(z.string()).catch([]).default([]),
  stopReason: nullableText,
  trace: z
    .array(
      z.object({
        step: z.string(),
        tool: z.string().nullable().catch(null).default(null),
        outcome: z.string().catch(''),
        at: nullableText,
      }),
    )
    .catch([])
    .default([]),
  startedAt: nullableText,
  endedAt: nullableText,
});
export type SkillRun = z.infer<typeof skillRunSchema>;
export const skillRunsSchema = z.object({
  data: z.array(skillRunSchema),
  nextCursor: z.string().nullable().catch(null).default(null),
});

export const TOOL_BLOCK_REASONS = [
  'integration_not_connected',
  'tool_disabled_for_workspace',
  'not_allowed_for_employee',
  'no_calendar_connected',
] as const;
export type ToolBlockReason = (typeof TOOL_BLOCK_REASONS)[number];

export const toolChoiceSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().catch(''),
  source: z.enum(['system', 'integration']).catch('system'),
  integrationSlug: nullableText,
  category: nullableText,
  riskLevel: nullableText,
  connected: z.boolean().catch(false),
  allowedForAgent: z.boolean().nullable().catch(null).default(null),
  reason: z.enum(TOOL_BLOCK_REASONS).nullable().catch(null).default(null),
});
export type ToolChoice = z.infer<typeof toolChoiceSchema>;
export const toolChoicesSchema = z.object({ data: z.array(toolChoiceSchema) });

/** `GET/PUT /api/ai-agents/:id/skills`. */
export const employeeSkillsSchema = z.object({
  data: z.object({
    aiAgentId: z.string().min(1),
    noSkillPolicy: z.enum(NO_SKILL_POLICIES).catch('answer_from_knowledge'),
    skills: z.array(
      z.object({
        skillId: z.string().min(1),
        mode: z.enum(SKILL_MODES).catch('watch'),
        order: z.number().int().catch(0),
        name: z.string().catch(''),
        status: z.enum(SKILL_STATUSES).catch('draft'),
        category: z.enum(SKILL_CATEGORIES).catch('other'),
        version: z.number().int().catch(0),
        runs: z.number().int().nonnegative().catch(0),
      }),
    ),
  }),
});
export type EmployeeSkills = z.infer<typeof employeeSkillsSchema>['data'];

/** `POST /api/ai-agents/:id/skills/fit` - can this employee run this skill, step by step. */
export const skillFitSchema = z.object({
  data: z.object({
    fits: z.boolean(),
    /** 1-based, as 07g says it: "She'll hand over at step 5". */
    handsOverAtStep: z.number().int().positive().nullable().catch(null).default(null),
    reason: nullableText,
    steps: z
      .array(
        z.object({
          stepId: z.string(),
          tools: z.array(
            z.object({
              name: z.string(),
              allowed: z.boolean().catch(false),
              connected: z.boolean().catch(false),
              reason: z.enum(TOOL_BLOCK_REASONS).nullable().catch(null).default(null),
            }),
          ),
        }),
      )
      .catch([])
      .default([]),
  }),
});
export type SkillFit = z.infer<typeof skillFitSchema>['data'];

/**
 * What a skill's row says in 09's last column.
 *
 *   draft     not running anywhere, not even in watch (Backend: a draft never runs)
 *   approval  a step asks first over an amount - 09's amber chip; the highest
 *   live      at least one employee has it On
 *   watch     carried only in Watch - "Watch only"
 *   unused    active, and nobody carries it
 */
export type SkillStanding =
  | { readonly kind: 'approval'; readonly amount: number }
  | { readonly kind: 'draft' | 'live' | 'watch' | 'unused' };

export function skillStanding(skill: Pick<Skill, 'steps' | 'status' | 'stats'>): SkillStanding {
  if (skill.status !== 'active') return { kind: 'draft' };
  const modes = (skill.stats?.usedBy ?? []).map((u) => u.mode);
  if (!modes.includes('on') && !modes.includes('watch')) return { kind: 'unused' };
  const amounts = skill.steps
    .map((s) => s.approvalOverAmount)
    .filter((a): a is number => a !== null);
  if (amounts.length > 0) return { kind: 'approval', amount: Math.max(...amounts) };
  return modes.includes('on') ? { kind: 'live' } : { kind: 'watch' };
}
