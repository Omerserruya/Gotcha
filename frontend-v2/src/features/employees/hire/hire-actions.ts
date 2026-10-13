'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { builderEndpoints, employeeEndpoints, skillEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

import type { HireRequest, HireResult, HireWrite } from './hire-plan';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ HIRING CREATES A REAL EMPLOYEE (Omer, 2026-10-13, H5)
 * ════════════════════════════════════════════════════════════════════════════
 * Runs only on the confirmation's "yes". A DRAFT through the builder, the
 * plan written onto it, and `complete()` LAST - only once every write took.
 * Read in `services/ai/src/routes/ai-agent-builder.ts` and `ai-agents.ts`;
 * the code wins over any note:
 *
 *   draft     POST /api/ai-agents/builder/start { goal, forceNew: true, locale }
 *             `forceNew`: without it /start RESUMES the workspace's latest
 *             unfinished draft - someone else's, perhaps - and this hire
 *             would be written over it. The goal seeds the draft: a role
 *             guessed from it, every active knowledge base attached, every
 *             lower-risk action of a connected system granted.
 *   settings  PATCH /api/ai-agents/:id { status: 'DRAFT', role, goal,
 *             escalationRules, integrationAccess, knowledgeBaseIds }
 *             `status: 'DRAFT'` on purpose: a PATCH on an unfinished
 *             builder draft PROMOTES it to ACTIVE when it looks ready (name,
 *             goal, knowledge) - before complete(), before the rest is
 *             written. Stated, it stays a draft. `role` and `goal` replace
 *             the seed's guesses; `knowledgeBaseIds` replaces the seed's
 *             attach-everything with the plan's. It also clears the
 *             builder's resume pointer, so the old builder never resumes it.
 *   name      POST /api/ai-agents/builder/:id/refinements { name }
 *   skills    PUT  /api/ai-agents/:id/skills [{ skillId, mode: 'watch', order }]
 *             only when skills were chosen
 *   levels    PUT  /api/ai-agents/:id/tool-levels/:toolName { level }
 *             one per action set stricter than the business's (E5's
 *             route; the builder's tool routes take no level)
 *   hired     POST /api/ai-agents/builder/:id/complete { locale }
 *             DRAFT -> ACTIVE, readiness report queued in the background
 *
 * A write that fails stops the run: nothing after it is tried, complete()
 * least of all. The answer names what was saved and what was not, and the
 * draft's id, so trying again continues the SAME draft (every write above
 * replaces, so a repeat is harmless) instead of leaving another behind.
 */
const startedSchema = z.object({ agentId: z.string().min(1) });
const anything = z.unknown();

/**
 * Why it stopped. `changed`: the actions or skills moved under the plan - an
 * action no longer offered (404 UNKNOWN_TOOL), one the business tightened
 * meanwhile (422 LOOSER_THAN_WORKSPACE), a skill gone (422 INVALID_SKILLS);
 * the draft is still there. `gone`: the draft itself is (404).
 */
function reasonOf(cause: unknown): Extract<HireResult, { ok: false }>['reason'] {
  if (!isApiError(cause)) return 'failed';
  if (cause.status === 403) return 'forbidden';
  if (['UNKNOWN_TOOL', 'LOOSER_THAN_WORKSPACE', 'INVALID_SKILLS'].includes(cause.code ?? '')) {
    return 'changed';
  }
  if (cause.status === 404) return 'gone';
  if (cause.code === 'INVALID_INTEGRATION_ACCESS') return 'invalid_access';
  if (cause.code === 'INVALID_ESCALATION_RULES') return 'invalid_rules';
  if (cause.status === 422) return 'not_ready';
  return 'failed';
}

export async function hireEmployee(
  request: HireRequest,
  draftId: string | null = null,
): Promise<HireResult> {
  const api = serverApi();
  const saved: HireWrite[] = [];
  let id = draftId;
  let at: HireWrite = 'draft';
  let levelsSaved = 0;
  try {
    if (id === null) {
      const started = await api.post({
        endpoint: builderEndpoints.start(),
        body: { goal: request.goal, forceNew: true, locale: request.locale },
        payload: startedSchema,
      });
      id = started.agentId;
    }
    saved.push('draft');

    at = 'settings';
    await api.patch({
      endpoint: employeeEndpoints.update(id),
      body: {
        status: 'DRAFT',
        role: request.role,
        goal: request.goal,
        escalationRules: request.escalationRules,
        integrationAccess: request.integrationAccess,
        knowledgeBaseIds: request.knowledgeBaseIds,
      },
      payload: anything,
    });
    saved.push('settings');

    at = 'name';
    await api.post({
      endpoint: builderEndpoints.refinements(id),
      body: { name: request.name },
      payload: anything,
    });
    saved.push('name');

    if (request.skillIds.length > 0) {
      at = 'skills';
      await api.put({
        endpoint: skillEndpoints.forEmployee(id),
        body: request.skillIds.map((skillId, order) => ({ skillId, mode: 'watch', order })),
        payload: anything,
      });
      saved.push('skills');
    }

    if (request.levels.length > 0) {
      at = 'levels';
      for (const { toolName, level } of request.levels) {
        await api.put({
          endpoint: employeeEndpoints.toolLevel(id, toolName),
          body: { level },
          payload: anything,
        });
        levelsSaved += 1;
      }
      saved.push('levels');
    }

    at = 'hired';
    await api.post({
      endpoint: builderEndpoints.complete(id),
      body: { locale: request.locale },
      payload: anything,
    });
    revalidatePath('/[locale]/(app)/studio/employees', 'layout');
    return { ok: true, id };
  } catch (cause) {
    await signInIfSignedOut(cause);
    const reason = reasonOf(cause);
    logger.warn('employees.hire_failed', {
      at,
      status: isApiError(cause) ? cause.status : undefined,
    });
    // A draft exists from here: the list shows it.
    if (id !== null) revalidatePath('/[locale]/(app)/studio/employees', 'layout');
    return {
      ok: false,
      // Gone: there is no draft to continue; the next try starts a new one.
      id: reason === 'gone' ? null : id,
      saved,
      failed: at,
      reason,
      levels: { saved: levelsSaved, total: request.levels.length },
    };
  }
}
