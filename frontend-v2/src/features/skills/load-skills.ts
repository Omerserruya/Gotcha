import 'server-only';

import { getLocale } from 'next-intl/server';

import { serverApi } from '@/api/client/server-api';
import { isApiError } from '@/api/client/api-error';
import {
  employeeSkillsSchema,
  skillFitSchema,
  skillOneSchema,
  skillsListSchema,
  type EmployeeSkills,
  type SkillFit,
  toolChoicesSchema,
  type Skill,
  type ToolChoice,
} from '@/api/contracts/skills';
import { employeeListSchema, responsibilityOf } from '@/api/contracts/employees';
import { employeeEndpoints, skillEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/** 09's "This week": the last seven days, as Backend's stats default. */
export function weekAgo(now: Date): string {
  return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
}

export interface SkillsLibrary {
  /** `null`: the read failed (or the route is not deployed yet) - never "no skills". */
  readonly skills: readonly Skill[] | null;
  /** Names the step tools as systems ("Shopify", "Knowledge"); `null` when unread. */
  readonly tools: ReadonlyMap<string, ToolChoice> | null;
}

export async function loadSkillsLibrary(now = new Date()): Promise<SkillsLibrary> {
  const api = serverApi();
  const [skills, tools] = await Promise.all([
    api
      .get({
        endpoint: skillEndpoints.list(),
        query: { from: weekAgo(now) },
        payload: skillsListSchema,
        raw: true,
      })
      .then((r) => r.data)
      .catch((cause: unknown) => {
        logger.warn('skills.list_failed', { cause });
        return null;
      }),
    api
      .get({
        endpoint: skillEndpoints.tools(),
        // GOTCHA's own tools come translated ("העברה לנציג אנושי").
        query: { locale: await getLocale() },
        payload: toolChoicesSchema,
        raw: true,
      })
      .then((r) => new Map(r.data.map((t) => [t.name, t])))
      .catch((cause: unknown) => {
        logger.warn('skills.tools_failed', { cause });
        return null;
      }),
  ]);
  return { skills, tools };
}

/**
 * The AI employees a skill can be given to - unfinished wizard drafts left
 * out, as everywhere else. `null`: unread.
 */
export async function loadSkillEmployees(): Promise<
  readonly { readonly id: string; readonly name: string; readonly role: string | null }[] | null
> {
  try {
    const list = await serverApi().get({
      endpoint: employeeEndpoints.list(),
      payload: employeeListSchema,
    });
    // The line under 07's name ("Sales and product advice"), not the role key.
    return list
      .filter((e) => e.status !== 'DRAFT')
      .map((e) => ({ id: e.id, name: e.name, role: responsibilityOf(e) }));
  } catch (cause) {
    logger.warn('skills.employees_failed', { cause });
    return null;
  }
}

export interface SkillRead {
  /** `null` with `missing`: no such skill here (404); without it, the read failed. */
  readonly skill: Skill | null;
  readonly missing: boolean;
  readonly tools: readonly ToolChoice[] | null;
  /** The other skills, for "Not for → another skill". */
  readonly others: readonly { readonly id: string; readonly name: string }[];
}

export async function loadSkill(id: string, now = new Date()): Promise<SkillRead> {
  const api = serverApi();
  const [one, library] = await Promise.all([
    api
      .get({
        endpoint: skillEndpoints.one(id),
        query: { from: weekAgo(now) },
        payload: skillOneSchema,
        raw: true,
      })
      .then((r) => ({ skill: r.data, missing: false }))
      .catch((cause: unknown) => {
        if (isApiError(cause) && cause.status === 404) return { skill: null, missing: true };
        logger.warn('skills.one_failed', { cause });
        return { skill: null, missing: false };
      }),
    loadSkillsLibrary(now),
  ]);
  return {
    ...one,
    tools: library.tools ? [...library.tools.values()] : null,
    others: (library.skills ?? [])
      .filter((s) => s.status !== 'archived' && s.id !== id)
      .map((s) => ({ id: s.id, name: s.name })),
  };
}

/** How many candidates 07g checks against the employee before showing them (one call each). */
export const FIT_CHECKS = 12;

export interface EmployeeSkillsTab {
  /** `null`: the employee's list could not be read. */
  readonly assigned: EmployeeSkills | null;
  /** Skills this employee does not carry yet, with who else does; `null`: unread. */
  readonly candidates:
    | readonly {
        readonly skill: Skill;
        readonly fit: SkillFit | null;
      }[]
    | null;
  /** Every skill's "in the customer's words" - for the rows the employee carries, too. */
  readonly situations: ReadonlyMap<string, string | null>;
}

/**
 * 07g's reads: the employee's ordered list, and the skills they could add -
 * each checked against what this employee may do (`/fit`), so "Add" says
 * where they would have to hand over before anyone presses it.
 */
export async function loadEmployeeSkillsTab(agentId: string): Promise<EmployeeSkillsTab> {
  const api = serverApi();
  const [assigned, library] = await Promise.all([
    api
      .get({
        endpoint: skillEndpoints.forEmployee(agentId),
        payload: employeeSkillsSchema,
        raw: true,
      })
      .then((r) => r.data)
      .catch((cause: unknown) => {
        logger.warn('skills.employee_tab_failed', { cause });
        return null;
      }),
    loadSkillsLibrary(),
  ]);
  const situations = new Map((library.skills ?? []).map((s) => [s.id, s.situation] as const));
  if (library.skills === null || assigned === null) {
    return { assigned, candidates: null, situations };
  }
  const carried = new Set(assigned.skills.map((s) => s.skillId));
  const open = library.skills.filter((s) => s.status !== 'archived' && !carried.has(s.id));
  const checked = await Promise.all(
    open.slice(0, FIT_CHECKS).map((skill) =>
      api
        .post({
          endpoint: skillEndpoints.fit(agentId),
          body: { skillId: skill.id },
          payload: skillFitSchema,
          raw: true,
        })
        .then((r) => r.data)
        .catch((cause: unknown) => {
          logger.warn('skills.fit_failed', { cause });
          return null;
        }),
    ),
  );
  return {
    assigned,
    candidates: open.map((skill, i) => ({ skill, fit: checked[i] ?? null })),
    situations,
  };
}
