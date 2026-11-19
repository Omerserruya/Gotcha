import 'server-only';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import {
  botIdleGroupsOf,
  botIdleResponseSchema,
  type BotIdleGroups,
} from '@/api/contracts/bot-idle-automation';
import { idleAutomationSchema, type IdleAutomation } from '@/api/contracts/idle-automation';
import { workspaceEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * Follow-up and auto-close for Settings · Workspace (S3). Owner only on the
 * server, the read included: anyone else reads a 403, and the row says whose
 * it is rather than offering an Edit that could not save.
 */
export type IdleSetup =
  | { readonly kind: 'owner'; readonly settings: IdleAutomation }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'failed' };

export async function loadIdleSetup(): Promise<IdleSetup> {
  return serverApi()
    .get({ endpoint: workspaceEndpoints.idleAutomation(), payload: idleAutomationSchema })
    .then((settings): IdleSetup => ({ kind: 'owner', settings }))
    .catch((cause: unknown): IdleSetup => {
      if (isApiError(cause) && cause.status === 403) return { kind: 'forbidden' };
      logger.warn('workspace.idle_failed', { cause });
      return { kind: 'failed' };
    });
}

/**
 * The AI employee's own follow-up and auto-close, per group. `unread` when
 * the read failed or described no group: the drawer then offers nothing to
 * change there, and the row says nothing about it.
 */
export type BotIdleSetup =
  { readonly kind: 'read'; readonly groups: BotIdleGroups } | { readonly kind: 'unread' };

export async function loadBotIdleSetup(): Promise<BotIdleSetup> {
  return serverApi()
    .get({ endpoint: workspaceEndpoints.botIdleAutomation(), payload: botIdleResponseSchema })
    .then((raw): BotIdleSetup => {
      const groups = botIdleGroupsOf(raw);
      return groups.liveChat || groups.messaging ? { kind: 'read', groups } : { kind: 'unread' };
    })
    .catch((cause: unknown): BotIdleSetup => {
      // Anyone but an Owner reads a 403 here, as the person-held read: not a failure to log.
      if (!(isApiError(cause) && cause.status === 403)) {
        logger.warn('workspace.bot_idle_failed', { cause });
      }
      return { kind: 'unread' };
    });
}
