import 'server-only';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import {
  automationListSchema,
  automationOneSchema,
  catalogSchema,
  nodeStatsSchema,
  webhookTriggerSchema,
  type Automation,
  type Catalog,
  type NodeStats,
  type WebhookTrigger,
} from '@/api/contracts/automations';
import { automationEndpoints } from '@/api/endpoints/registry';
import { loadPeople } from '@/features/people/load-people';
import { loadSkillsLibrary } from '@/features/skills/load-skills';
import { logger } from '@/observability/logger';

/**
 * 09c's list - newest first, each with its path and this week's runs.
 * `null` is a failed read and never an empty list; `'forbidden'` is no
 * `ai:workflows:read` (Backend 5: 403 PERMISSION_DENIED) - a person without
 * access, not a broken screen.
 */
export async function loadAutomations(): Promise<readonly Automation[] | null | 'forbidden'> {
  try {
    const list = await serverApi().get({
      endpoint: automationEndpoints.list(),
      payload: automationListSchema,
      raw: true,
    });
    return list.data;
  } catch (cause) {
    if (isApiError(cause) && cause.status === 403) return 'forbidden';
    logger.warn('automations.list_failed', { cause });
    return null;
  }
}

/** 09e's catalogue for a page that opens the sheet on arrival (New automation). `null`: unread. */
export async function loadCatalog(
  where: { readonly automationId?: string; readonly after?: string } = {},
): Promise<Catalog | null> {
  try {
    const answer = await serverApi().get({
      endpoint: automationEndpoints.catalog(),
      payload: catalogSchema,
      raw: true,
      query: { automationId: where.automationId, after: where.after },
    });
    return answer.data;
  } catch (cause) {
    logger.warn('automations.catalog_failed', { cause });
    return null;
  }
}

export interface BuilderRead {
  /** `null` with `missing`: no such automation here; with `forbidden`: no access; else unread. */
  readonly automation: Automation | null;
  readonly missing: boolean;
  readonly forbidden: boolean;
  /** Per step, the last 7 days. `null`: unread. */
  readonly stats: NodeStats | null;
  /** For the webhook trigger's inspector. `null`: none yet, or unread. */
  readonly webhook: WebhookTrigger | null;
  /** The inspector's choices. Each `null` when unread. */
  readonly employees: readonly { readonly id: string; readonly name: string }[] | null;
  readonly teams: readonly { readonly id: string; readonly name: string }[] | null;
  readonly members: readonly { readonly id: string; readonly name: string }[] | null;
  readonly skills: readonly { readonly id: string; readonly name: string }[] | null;
}

/** 09d: the automation with its graph, its step stats, and who and what its steps can name. */
export async function loadBuilder(id: string): Promise<BuilderRead> {
  const api = serverApi();
  const [one, stats, webhook, people, library] = await Promise.all([
    api
      .get({ endpoint: automationEndpoints.one(id), payload: automationOneSchema, raw: true })
      .then((r) => ({ automation: r.data as Automation | null, missing: false, forbidden: false }))
      .catch((cause: unknown) => {
        if (isApiError(cause) && cause.status === 404) {
          return { automation: null, missing: true, forbidden: false };
        }
        if (isApiError(cause) && cause.status === 403) {
          return { automation: null, missing: false, forbidden: true };
        }
        logger.warn('automations.one_failed', { cause });
        return { automation: null, missing: false, forbidden: false };
      }),
    api
      .get({
        endpoint: automationEndpoints.nodeStats(id),
        payload: nodeStatsSchema,
        raw: true,
        query: { days: '7' },
      })
      .then((r) => r.data)
      .catch(() => null),
    api
      .get({
        endpoint: automationEndpoints.webhookTriggers(),
        payload: webhookTriggerSchema,
        raw: true,
        query: { workflowId: id },
      })
      .then((r) => r.data)
      .catch(() => null),
    loadPeople(),
    loadSkillsLibrary(),
  ]);
  const named = <T extends { id: string }>(rows: readonly T[] | null, name: (row: T) => string) =>
    rows?.map((r) => ({ id: r.id, name: name(r) })).filter((r) => r.name.trim() !== '') ?? null;
  return {
    ...one,
    stats,
    webhook,
    employees: named(people.aiEmployees, (e) => e.name),
    teams: named(people.teams, (t) => t.name),
    members: named(people.members, (m) => m.name || m.email || ''),
    skills: library.skills
      ? library.skills
          .filter((s) => s.status !== 'archived')
          .map((s) => ({ id: s.id, name: s.name }))
      : null,
  };
}
