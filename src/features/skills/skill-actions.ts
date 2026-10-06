'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import {
  NO_SKILL_POLICIES,
  employeeSkillsSchema,
  skillFitSchema,
  skillOneSchema,
  skillRunsSchema,
  toolChoicesSchema,
  type EmployeeSkills,
  type NoSkillPolicy,
  type Skill,
  type SkillFit,
  type SkillMode,
  type SkillRun,
  type ToolChoice,
} from '@/api/contracts/skills';
import { skillEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

import type { SkillBody } from './skill-draft';

export type SaveResult =
  | { readonly ok: true; readonly skill: Skill }
  /** Backend's 422 `INVALID_SKILL`: shown at `field`, in its words. */
  | {
      readonly ok: false;
      readonly reason: 'invalid';
      readonly field: string | null;
      readonly error: string;
    }
  | { readonly ok: false; readonly reason: 'forbidden' | 'not_found' | 'failed' };

/** After `signInIfSignedOut` in the catch itself - the guard reads each catch. */
const failed = (cause: unknown, event: string): SaveResult => {
  if (isApiError(cause) && cause.status === 422) {
    return {
      ok: false,
      reason: 'invalid',
      field: cause.field ?? null,
      error: cause.developerMessage ?? '',
    };
  }
  if (isApiError(cause) && cause.status === 403) return { ok: false, reason: 'forbidden' };
  if (isApiError(cause) && cause.status === 404) return { ok: false, reason: 'not_found' };
  logger.warn(event, { status: isApiError(cause) ? cause.status : undefined });
  return { ok: false, reason: 'failed' };
};

/** 21's Save: a draft, version 1. Nothing runs until it is made active. */
export async function createSkill(body: SkillBody): Promise<SaveResult> {
  try {
    const { data } = await serverApi().post({
      endpoint: skillEndpoints.list(),
      body,
      payload: skillOneSchema,
      raw: true,
    });
    revalidatePath('/[locale]/studio/skills', 'page');
    return { ok: true, skill: data };
  } catch (cause) {
    await signInIfSignedOut(cause);
    return failed(cause, 'skills.create_failed');
  }
}

/** 09b's Save, and 21's "start it": only what is sent changes; every PUT is a new version. */
export async function saveSkill(
  id: string,
  body: Partial<SkillBody> & { status?: 'draft' | 'active' },
): Promise<SaveResult> {
  try {
    const { data } = await serverApi().put({
      endpoint: skillEndpoints.one(id),
      body,
      payload: skillOneSchema,
      raw: true,
    });
    revalidatePath('/[locale]/studio/skills', 'layout');
    return { ok: true, skill: data };
  } catch (cause) {
    await signInIfSignedOut(cause);
    return failed(cause, 'skills.save_failed');
  }
}

/**
 * 09b's Archive: DELETE is an archive (Backend b9278d7e). Employees stop
 * using it; a conversation in the middle of it finishes on its version; the
 * run history is kept. `false`: it did not happen.
 */
export async function archiveSkill(id: string): Promise<boolean> {
  try {
    await serverApi().delete({
      endpoint: skillEndpoints.one(id),
      payload: skillOneSchema,
      raw: true,
    });
    revalidatePath('/[locale]/studio/skills', 'layout');
    return true;
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('skills.archive_failed', { status: isApiError(cause) ? cause.status : undefined });
    return false;
  }
}

/** The step editor's tool choices; with an employee, whether each is allowed for them. */
export async function readTools(agentId?: string): Promise<readonly ToolChoice[] | null> {
  try {
    const { data } = await serverApi().get({
      endpoint: skillEndpoints.tools(),
      query: agentId ? { agentId } : {},
      payload: toolChoicesSchema,
      raw: true,
    });
    return data;
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('skills.tools_failed', { status: isApiError(cause) ? cause.status : undefined });
    return null;
  }
}

/** 09b's run log, a page at a time. Only conversations the viewer may see. */
export async function readRuns(
  id: string,
  cursor: string | null,
): Promise<{ readonly runs: readonly SkillRun[]; readonly nextCursor: string | null } | null> {
  try {
    const page = await serverApi().get({
      endpoint: skillEndpoints.runs(id),
      query: { limit: 20, ...(cursor ? { cursor } : {}) },
      payload: skillRunsSchema,
      raw: true,
    });
    return { runs: page.data, nextCursor: page.nextCursor };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('skills.runs_failed', { status: isApiError(cause) ? cause.status : undefined });
    return null;
  }
}

export async function readEmployeeSkills(agentId: string): Promise<EmployeeSkills | null> {
  try {
    const { data } = await serverApi().get({
      endpoint: skillEndpoints.forEmployee(agentId),
      payload: employeeSkillsSchema,
      raw: true,
    });
    return data;
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('skills.employee_read_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return null;
  }
}

/**
 * An employee's whole skill list, in order - Backend's PUT replaces it, and a
 * skill missing from it is removed. Callers send the list they read, changed.
 */
export async function setEmployeeSkills(
  agentId: string,
  skills: readonly { readonly skillId: string; readonly mode: SkillMode }[],
): Promise<EmployeeSkills | null> {
  try {
    const { data } = await serverApi().put({
      endpoint: skillEndpoints.forEmployee(agentId),
      body: skills.map((s, order) => ({ skillId: s.skillId, mode: s.mode, order })),
      payload: employeeSkillsSchema,
      raw: true,
    });
    revalidatePath('/[locale]/studio', 'layout');
    return data;
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('skills.employee_write_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return null;
  }
}

/**
 * Give one skill to one employee in a mode, or take it away (`null`): read
 * their list, change that one row, write the whole list back.
 */
export async function giveSkill(
  agentId: string,
  skillId: string,
  mode: SkillMode | null,
): Promise<EmployeeSkills | null> {
  const current = await readEmployeeSkills(agentId);
  if (current === null) return null;
  const rest = current.skills.filter((s) => s.skillId !== skillId);
  const had = current.skills.find((s) => s.skillId === skillId);
  const next =
    mode === null
      ? rest
      : had
        ? current.skills.map((s) => (s.skillId === skillId ? { ...s, mode } : s))
        : [...current.skills, { skillId, mode }];
  return setEmployeeSkills(
    agentId,
    next.map((s) => ({ skillId: s.skillId, mode: s.mode })),
  );
}

export async function checkFit(agentId: string, skillId: string): Promise<SkillFit | null> {
  try {
    const { data } = await serverApi().post({
      endpoint: skillEndpoints.fit(agentId),
      body: { skillId },
      payload: skillFitSchema,
      raw: true,
    });
    return data;
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('skills.fit_failed', { status: isApiError(cause) ? cause.status : undefined });
    return null;
  }
}

/** 07g's "When no skill fits". A PATCH on the employee - not a PUT, which replaces it. */
export async function setNoSkillPolicy(agentId: string, policy: NoSkillPolicy): Promise<boolean> {
  if (!(NO_SKILL_POLICIES as readonly string[]).includes(policy)) return false;
  try {
    await serverApi().patch({
      endpoint: skillEndpoints.employee(agentId),
      body: { noSkillPolicy: policy },
      payload: z.unknown(),
      raw: true,
    });
    revalidatePath('/[locale]/studio/employees', 'layout');
    return true;
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('skills.policy_failed', { status: isApiError(cause) ? cause.status : undefined });
    return false;
  }
}
