import type { AdminChoice } from '@/api/contracts/capabilities';

import {
  knowledgePatch,
  reachedByScope,
  type EmployeeKnowledgeSource,
} from '../page/knowledge-plan';
import { rulesBody, rulesProblem, type DraftRule } from '../page/profile-plan';

/**
 * 07b-07d's choices, held locally until the hire is confirmed (H5), then
 * written by `hire-actions.ts` - each field to its route:
 *
 *   job + goal     → POST /builder/start { goal } (the DRAFT), then
 *                    PATCH /api/ai-agents/:id { role, goal }
 *   rules          → PATCH /api/ai-agents/:id { escalationRules } (H3)
 *   access         → PATCH /api/ai-agents/:id { integrationAccess }
 *   knowledge      → PATCH /api/ai-agents/:id { knowledgeBaseIds } (H4)
 *   name           → POST /builder/:id/refinements { name }
 *   skills         → PUT /api/ai-agents/:id/skills (H4), each in Watch
 *   choices        → PUT /api/ai-agents/:id/tool-levels/:toolName { level },
 *                    one per action set stricter than the business
 *   disclosesAi    → PATCH /api/ai-agents/:id { disclosesAi }
 *   funnelId       → PATCH /api/ai-agents/:id { role: 'sales', funnelId },
 *                    together, in the one PATCH (Sales only)
 *   funnelTemplate → POST /api/funnels { template } first (inactive; the
 *                    same template again reuses its funnel), then its row's
 *                    id in that PATCH
 *   grants         → POST /builder/:id/tool { toolName } / { toolName,
 *                    attach: false }, only where the draft differs
 *   Hire, confirmed → POST /builder/:id/complete (DRAFT → ACTIVE)
 */
export interface HirePlan {
  readonly job: HireJob | null;
  /** The job in their own words, when the job is "Something else". */
  readonly goal: string;
  readonly name: string;
  readonly choices: Readonly<Record<string, AdminChoice>>;
  /**
   * The business systems it may use, by key (an integration's slug, or
   * `custom:<id>`). Starts where the server starts a new employee: every
   * system the workspace has set up today, in any state.
   */
  readonly access: readonly string[];
  /**
   * "Always hand over to a person when…" (H3): the conditions, in the
   * employee page's own model (`profile-plan.ts`) - each its words and
   * whether it is on. Sent as `escalationRules`, at most 50, 1-300 each.
   */
  readonly rules: readonly DraftRule[];
  /**
   * The knowledge bases it is connected to, by id (H4) - the employee
   * page's rule (`knowledge-plan.ts`). Starts as every active one.
   */
  readonly knowledge: readonly string[];
  /** The business skills it carries, by id, in order (H4). Starts empty. */
  readonly skills: readonly string[];
  /**
   * Which integration actions are GIVEN to it, by tool name: an integration
   * tool reaches an employee only when granted (`AgentToolPermission`).
   * Starts where the builder's seed starts. Built-ins need no grant.
   */
  readonly grants: Readonly<Record<string, boolean>>;
  /** "Says it's AI when asked" - the Profile tab's switch. Starts on. */
  readonly disclosesAi: boolean;
  /** The sales funnel it follows (`TenantFunnel.id`, never its slug); Sales only. */
  readonly funnelId: string | null;
  /**
   * Or a ready-made funnel to start from (a template id), created only on
   * the hire's "yes". One of the two, never both.
   */
  readonly funnelTemplate: string | null;
}

/** The builder's roles (`agent-builder.service.ts`), plus the free-text job. */
export const HIRE_JOBS = ['customer_support', 'sales', 'booking', 'custom'] as const;
export type HireJob = (typeof HIRE_JOBS)[number];

/**
 * 02's suggested "Always hand over to a person when…" chips: quick adds, each
 * adding a condition in its words (H3). The first is where a hire starts.
 */
export const HANDOVER_SUGGESTIONS = ['askPerson', 'annoyed', 'vip', 'askedTwice'] as const;

/** One of the business's actions, as step 2 draws it. */
export interface HireTool {
  readonly toolName: string;
  /** The action in words ("Get customer") - the tool catalogue's `actionLabel`. */
  readonly label: string;
  /** Its integration's slug and name; `null`: one of GOTCHA's own actions. */
  readonly provider: string | null;
  readonly providerLabel: string | null;
  readonly choices: readonly AdminChoice[];
  readonly current: AdminChoice;
  /**
   * An integration action's grant; `null` for a built-in, which needs none.
   *   grantable  the workspace has set it up (capability state is not
   *              `not_provisioned`) - the grant route refuses one that is
   *              not (404 TOOL_NOT_PROVISIONED)
   *   seeded     what the builder's seed gives it (`seedDraftFromGoal`):
   *              an enabled tool of a CONNECTED integration whose catalogue
   *              riskLevel is not high
   */
  readonly grant: { readonly grantable: boolean; readonly seeded: boolean } | null;
}

/** The seed's rule (`agent-builder.service.ts`), for one capability's facts. */
export function seededGrant(capability: {
  readonly state?: 'enabled' | 'disabled' | 'not_provisioned';
  readonly riskLevel: string | null;
}): boolean {
  return capability.state === 'enabled' && !/high|critical/i.test(capability.riskLevel ?? '');
}

/** A sales funnel the hire may follow: a `GET /api/funnels` row, active. */
export interface HireFunnel {
  readonly id: string;
  readonly name: string;
}

/** The funnels read: the active ones, or why they are not known. */
export type HireFunnels = readonly HireFunnel[] | 'failed' | 'forbidden';

/** A ready-made funnel (`GET /api/funnels/templates`), in the reader's language. */
export interface HireFunnelTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly stages: readonly { readonly id: string; readonly label: string }[];
}

/** The templates read, or why they are not known. */
export type HireTemplates = readonly HireFunnelTemplate[] | 'failed' | 'forbidden';

/** Jobs whose employee must follow a funnel (`FUNNEL_REQUIRED_ROLES`: sales, sdr, recruiting). */
export function needsFunnel(job: HireJob | null): boolean {
  return job === 'sales';
}

/**
 * Step 2's groups (Omer, 2026-10-07): one per integration, by name, THEN
 * GOTCHA's own. The integrations come first because they are what the
 * question is about, and GOTCHA's own list is long (16 rows on dev): first,
 * it put them below the fold (supervisor, 2026-10-07).
 */
export function toolGroups(tools: readonly HireTool[]): readonly {
  readonly provider: string | null;
  readonly label: string | null;
  readonly tools: readonly HireTool[];
}[] {
  const byProvider = new Map<string | null, HireTool[]>();
  for (const tool of tools) {
    const list = byProvider.get(tool.provider) ?? [];
    list.push(tool);
    byProvider.set(tool.provider, list);
  }
  const own = byProvider.get(null);
  const integrations = [...byProvider.entries()]
    .filter(([provider]) => provider !== null)
    .map(([provider, list]) => ({ provider, label: list[0]!.providerLabel, tools: list }))
    .sort((a, b) => (a.label ?? a.provider ?? '').localeCompare(b.label ?? b.provider ?? ''));
  return [...integrations, ...(own ? [{ provider: null, label: null, tools: own }] : [])];
}

/**
 * Step 1 is complete when there is a job - and, for "Something else", words -
 * and a name: the builder completes no employee called "Untitled" (H5).
 */
export function stepOneDone(plan: HirePlan): boolean {
  if (plan.job === null || plan.name.trim() === '') return false;
  return plan.job !== 'custom' || plan.goal.trim().length > 0;
}

/*
 * ★ No "Where should it work?" (Omer, 2026-10-07): where an employee works is
 *   the playbook's and the automations' to decide, not a field on it - so the
 *   plan holds no channels and the builder is never sent any.
 */
export function emptyPlan(
  tools: readonly HireTool[],
  setUp: readonly string[] = [],
  {
    rules = [],
    knowledge = [],
  }: {
    /** The conditions a hire starts with - the first chip, in the reader's words. */
    readonly rules?: readonly DraftRule[];
    /** The knowledge it starts connected to (`knowledgeDefault`). */
    readonly knowledge?: readonly string[];
  } = {},
): HirePlan {
  const providers = tools.map((tool) => tool.provider).filter((p): p is string => p !== null);
  return {
    job: null,
    goal: '',
    name: '',
    choices: Object.fromEntries(tools.map((tool) => [tool.toolName, tool.current])),
    access: [...new Set([...setUp, ...providers])].sort(),
    rules,
    knowledge,
    skills: [],
    grants: Object.fromEntries(
      tools.flatMap((tool) =>
        tool.grant ? [[tool.toolName, tool.grant.grantable && tool.grant.seeded]] : [],
      ),
    ),
    disclosesAi: true,
    funnelId: null,
    funnelTemplate: null,
  };
}

/** The plan with one system allowed or not. */
export function withAccess(plan: HirePlan, key: string, on: boolean): HirePlan {
  const rest = plan.access.filter((k) => k !== key);
  return { ...plan, access: on ? [...rest, key].sort() : rest };
}

/* ── H4/H5: knowledge, skills, the summary and the hire ─────────────────── */

/** A knowledge base, as step 3 draws it - the page's read (`knowledge-plan.ts`). */
export type HireSource = EmployeeKnowledgeSource;

/** A business skill step 3 offers (`GET /api/business-skills`, archived left out). */
export interface HireSkill {
  readonly id: string;
  readonly name: string;
  readonly situation: string | null;
  readonly status: 'draft' | 'active';
}

/** A hire has no id and no department yet: only `all` reaches it by scope. */
export const NEW_HIRE = { id: null, departmentId: null } as const;

/**
 * Where a hire's knowledge starts: every active knowledge base - as the
 * builder's own seed attaches them (`seedDraftFromGoal`), since an employee
 * with none attached cannot be completed (`draftReadiness`: "knowledge").
 */
export function knowledgeDefault(sources: readonly HireSource[] | null): readonly string[] {
  return (sources ?? [])
    .filter((s) => s.isActive)
    .map((s) => s.id)
    .sort();
}

/**
 * The knowledge bases the hire is connected to (`knowledgeBaseIds`): the
 * ones switched on that still exist, and every active one its scope already
 * reaches - those have no switch (`knowledge-plan.ts`), and stay attached,
 * as the page's own rule keeps them.
 */
export function hireKnowledgeIds(plan: HirePlan, sources: readonly HireSource[]): string[] {
  const known = new Set(sources.map((s) => s.id));
  const fixed = sources.filter((s) => s.isActive && reachedByScope(s, NEW_HIRE)).map((s) => s.id);
  return knowledgePatch([...plan.knowledge.filter((id) => known.has(id)), ...fixed])
    .knowledgeBaseIds;
}

/** The skills it will carry, in the order chosen, each still offered. */
export function hireSkillIds(plan: HirePlan, skills: readonly HireSkill[]): string[] {
  const known = new Set(skills.map((s) => s.id));
  return plan.skills.filter((id) => known.has(id));
}

/** Do it, Ask me, Never - each stricter than the one before. */
const STRICTNESS: Record<AdminChoice, number> = { do_it: 0, ask_me: 1, never: 2 };

/**
 * What one employee may be set to: within the action's ceiling, and never
 * looser than the business has it today - the route's rule
 * (`PUT /:id/tool-levels/:toolName`: 422 LOOSER_THAN_WORKSPACE).
 */
export function allowedChoices(tool: HireTool): readonly AdminChoice[] {
  return tool.choices.filter((c) => STRICTNESS[c] >= STRICTNESS[tool.current]);
}

/** The route's word for each choice (`ToolLevel`). */
const LEVEL: Record<AdminChoice, 'execute' | 'ask' | 'never'> = {
  do_it: 'execute',
  ask_me: 'ask',
  never: 'never',
};

/**
 * One write per action set differently from the business: the route stores
 * "the same as the business" as no level of its own, so the rest need none.
 */
export function hireLevels(
  plan: HirePlan,
  tools: readonly HireTool[],
): { readonly toolName: string; readonly level: 'execute' | 'ask' | 'never' }[] {
  return tools.flatMap((tool) => {
    const chosen = plan.choices[tool.toolName];
    return chosen && chosen !== tool.current
      ? [{ toolName: tool.toolName, level: LEVEL[chosen] }]
      : [];
  });
}

/**
 * The grant each action should end with: every integration action the
 * workspace has set up, given or not as the plan says. One the workspace has
 * not set up is never sent (the route would refuse it).
 */
export function hireGrants(
  plan: HirePlan,
  tools: readonly HireTool[],
): { readonly toolName: string; readonly give: boolean }[] {
  return tools.flatMap((tool) =>
    tool.grant?.grantable
      ? [{ toolName: tool.toolName, give: plan.grants[tool.toolName] === true }]
      : [],
  );
}

/** Why the summary cannot hire yet, in its order; empty when it can. */
export type HireBlock =
  | 'rules'
  | 'funnelsForbidden'
  | 'funnelsUnread'
  | 'noFunnel'
  | 'noFunnelTemplatesUnread'
  | 'pickFunnel'
  | 'knowledgeUnread'
  | 'noKnowledge';

/** The funnel the plan holds, still offered: an existing row, or a template to create. */
export function chosenFunnel(
  plan: HirePlan,
  funnels: HireFunnels,
  templates: HireTemplates,
): { readonly id: string } | { readonly template: string } | null {
  if (typeof funnels !== 'string' && funnels.some((f) => f.id === plan.funnelId)) {
    return { id: plan.funnelId! };
  }
  if (typeof templates !== 'string' && templates.some((t) => t.id === plan.funnelTemplate)) {
    return { template: plan.funnelTemplate! };
  }
  return null;
}

export function hireBlocks(
  plan: HirePlan,
  sources: readonly HireSource[] | null,
  funnels: HireFunnels = [],
  templates: HireTemplates = [],
): HireBlock[] {
  const blocks: HireBlock[] = [];
  if (rulesProblem(plan.rules) !== null) blocks.push('rules');
  // A pipeline role is completed only with a funnel (`draftReadiness`; the PATCH's 422).
  if (needsFunnel(plan.job) && chosenFunnel(plan, funnels, templates) === null) {
    const offered =
      (typeof funnels !== 'string' && funnels.length > 0) ||
      (typeof templates !== 'string' && templates.length > 0);
    // Both reads are ADMIN-only: a refusal of either is said as one.
    if (offered) blocks.push('pickFunnel');
    else if (funnels === 'forbidden' || templates === 'forbidden') blocks.push('funnelsForbidden');
    else if (funnels === 'failed') blocks.push('funnelsUnread');
    else if (templates === 'failed') blocks.push('noFunnelTemplatesUnread');
    else blocks.push('noFunnel');
  }
  if (sources === null) blocks.push('knowledgeUnread');
  else if (hireKnowledgeIds(plan, sources).length === 0) blocks.push('noKnowledge');
  return blocks;
}

/** Each write of a hire, in the order it runs. */
export const HIRE_WRITES = [
  'draft',
  'funnel',
  'settings',
  'name',
  'grants',
  'skills',
  'levels',
  'hired',
] as const;
export type HireWrite = (typeof HIRE_WRITES)[number];

/** What `hireEmployee` sends: the plan, made into the routes' bodies. */
export interface HireRequest {
  readonly goal: string;
  readonly role: HireJob;
  readonly name: string;
  readonly escalationRules: readonly Record<string, unknown>[];
  readonly integrationAccess: readonly string[];
  readonly knowledgeBaseIds: readonly string[];
  readonly disclosesAi: boolean;
  /**
   * Sales only: an existing funnel's row id, sent with `role` in the one
   * PATCH - or a template, created first and its row's id sent so; `null`
   * for a job that needs none.
   */
  readonly funnel: { readonly id: string } | { readonly template: string } | null;
  /** Every grantable integration action, given or not - the action sends only the difference. */
  readonly grants: readonly { readonly toolName: string; readonly give: boolean }[];
  readonly skillIds: readonly string[];
  readonly levels: readonly {
    readonly toolName: string;
    readonly level: 'execute' | 'ask' | 'never';
  }[];
  readonly locale: string;
}

export type HireResult =
  | { readonly ok: true; readonly id: string }
  | {
      readonly ok: false;
      /** The draft that exists, to continue; `null`: none (nothing created, or it is gone). */
      readonly id: string | null;
      readonly saved: readonly HireWrite[];
      readonly failed: HireWrite;
      readonly reason:
        | 'forbidden'
        | 'gone'
        | 'invalid_access'
        | 'invalid_rules'
        | 'changed'
        | 'not_provisioned'
        | 'unknown_template'
        | 'not_ready'
        | 'failed';
      /** How many of the action limits were written before it stopped. */
      readonly levels: { readonly saved: number; readonly total: number };
      /** How many grant changes were written before it stopped, of how many needed. */
      readonly grants: { readonly saved: number; readonly total: number };
    };

/** The writes this request makes, in order - skills and levels only when there are any. */
export function writesOf(request: HireRequest): readonly HireWrite[] {
  return HIRE_WRITES.filter(
    (w) =>
      (w !== 'funnel' || (request.funnel !== null && 'template' in request.funnel)) &&
      (w !== 'grants' || request.grants.length > 0) &&
      (w !== 'skills' || request.skillIds.length > 0) &&
      (w !== 'levels' || request.levels.length > 0),
  );
}

export function hireRequest(
  plan: HirePlan,
  {
    goal,
    tools,
    sources,
    skills,
    locale,
    funnels = [],
    templates = [],
  }: {
    readonly goal: string;
    readonly tools: readonly HireTool[];
    readonly sources: readonly HireSource[];
    readonly skills: readonly HireSkill[] | null;
    readonly locale: string;
    readonly funnels?: HireFunnels;
    readonly templates?: HireTemplates;
  },
): HireRequest {
  return {
    goal,
    role: plan.job!,
    name: plan.name.trim(),
    escalationRules: rulesBody(plan.rules),
    integrationAccess: [...plan.access].sort(),
    knowledgeBaseIds: hireKnowledgeIds(plan, sources),
    disclosesAi: plan.disclosesAi,
    funnel: needsFunnel(plan.job) ? chosenFunnel(plan, funnels, templates) : null,
    grants: hireGrants(plan, tools),
    // Unread, they are sent as chosen: the route refuses one that is gone (422).
    skillIds: skills ? hireSkillIds(plan, skills) : [...plan.skills],
    levels: hireLevels(plan, tools),
    locale,
  };
}
