'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { employeeToolsSchema } from '@/api/contracts/employees';
import {
  builderEndpoints,
  employeeEndpoints,
  funnelEndpoints,
  skillEndpoints,
} from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

import { setEmployeeToolGrant } from '../page/tool-grant-actions';
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
 *   funnel    POST /api/funnels { template } - only for a Sales hire starting
 *             from a ready-made funnel. Never `isActive`: an active funnel
 *             becomes the workspace's default for every conversation, and an
 *             employee binds one by id without it. The same template again
 *             answers the funnel already made (200, created: false), so a
 *             retry is safe. 400 UNKNOWN_TEMPLATE.
 *   settings  PATCH /api/ai-agents/:id { status: 'DRAFT', role, goal,
 *             escalationRules, integrationAccess, knowledgeBaseIds }
 *             `status: 'DRAFT'` on purpose: a PATCH on an unfinished
 *             builder draft PROMOTES it to ACTIVE when it looks ready (name,
 *             goal, knowledge) - before complete(), before the rest is
 *             written. Stated, it stays a draft. `role` and `goal` replace
 *             the seed's guesses; `knowledgeBaseIds` replaces the seed's
 *             attach-everything with the plan's. It also clears the
 *             builder's resume pointer, so the old builder never resumes it.
 *             It also carries `disclosesAi`, and for Sales `funnelId` WITH
 *             `role` - apart, the route answers 422 funnel_required_for_role.
 *   name      POST /api/ai-agents/builder/:id/refinements { name }
 *   grants    GET  /api/ai-agents/:id/tools - the draft's real `granted` per
 *             tool, after the seed - then, only where it differs from the plan,
 *             POST /api/ai-agents/builder/:id/tool { toolName } to give,
 *             { toolName, attach: false } to take away (404
 *             TOOL_NOT_PROVISIONED: not set up in the workspace) - through
 *             the employee page's `setEmployeeToolGrant`, never a copy
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
/** The funnel row (`data`, unwrapped); only its id is used, so `created` beside it is not read. */
const funnelRowSchema = z.object({ id: z.string().min(1) });
const anything = z.unknown();

/** A grant the shared action refused, carried to the one catch with its reason. */
class GrantRefused extends Error {
  constructor(readonly reason: 'not_provisioned' | 'forbidden' | 'failed') {
    super(reason);
  }
}

/**
 * Why it stopped. `changed`: the actions or skills moved under the plan - an
 * action no longer offered (404 UNKNOWN_TOOL), one the business tightened
 * meanwhile (422 LOOSER_THAN_WORKSPACE), a skill gone (422 INVALID_SKILLS);
 * the draft is still there. `gone`: the draft itself is (404).
 */
function reasonOf(cause: unknown): Extract<HireResult, { ok: false }>['reason'] {
  if (cause instanceof GrantRefused) return cause.reason;
  if (!isApiError(cause)) return 'failed';
  if (cause.status === 403) return 'forbidden';
  if (cause.code === 'TOOL_NOT_PROVISIONED') return 'not_provisioned';
  if (cause.code === 'UNKNOWN_TEMPLATE') return 'unknown_template';
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
  let grantsSaved = 0;
  let grantsTotal = 0;
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

    let funnelId: string | null = null;
    if (request.funnel !== null && 'template' in request.funnel) {
      at = 'funnel';
      const row = await api.post({
        endpoint: funnelEndpoints.create(),
        body: { template: request.funnel.template },
        payload: funnelRowSchema,
      });
      funnelId = row.id;
      saved.push('funnel');
    } else if (request.funnel !== null) {
      funnelId = request.funnel.id;
    }

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
        disclosesAi: request.disclosesAi,
        // With the role, in this one PATCH: apart, 422 funnel_required_for_role.
        ...(funnelId !== null ? { funnelId } : {}),
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

    if (request.grants.length > 0) {
      at = 'grants';
      const tools = await api.get({
        endpoint: employeeEndpoints.tools(id),
        payload: employeeToolsSchema,
      });
      const granted = new Map(tools.map((tool) => [tool.toolName, tool.granted === true]));
      const changes = request.grants.filter((g) => (granted.get(g.toolName) ?? false) !== g.give);
      grantsTotal = changes.length;
      for (const { toolName, give } of changes) {
        // The employee page's own grant action (POST /builder/:id/tool), shared.
        const result = await setEmployeeToolGrant(id, toolName, give);
        if (!result.ok) throw new GrantRefused(result.reason);
        grantsSaved += 1;
      }
      saved.push('grants');
    }

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
      grants: { saved: grantsSaved, total: grantsTotal },
    };
  }
}
