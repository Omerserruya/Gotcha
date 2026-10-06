import 'server-only';

import { serverApi } from '@/api/client/server-api';
import { isApiError } from '@/api/client/api-error';
import {
  skillOneSchema,
  skillsListSchema,
  toolChoicesSchema,
  type Skill,
  type ToolChoice,
} from '@/api/contracts/skills';
import { aiEmployeesSchema, isBuilderDraft } from '@/api/contracts/people';
import { aiEmployeeEndpoints, skillEndpoints } from '@/api/endpoints/registry';
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
      .get({ endpoint: skillEndpoints.tools(), payload: toolChoicesSchema, raw: true })
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
      endpoint: aiEmployeeEndpoints.list(),
      payload: aiEmployeesSchema,
    });
    return list
      .filter((ai) => !isBuilderDraft(ai))
      .map((ai) => ({ id: ai.id, name: ai.name, role: ai.role }));
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
