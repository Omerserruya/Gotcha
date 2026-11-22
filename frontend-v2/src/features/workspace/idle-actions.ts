'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import {
  BOT_IDLE_GROUPS,
  botIdleBody,
  botIdleGroupProblem,
  type BotIdleGroupKey,
  type BotIdleGroupWrite,
} from '@/api/contracts/bot-idle-automation';
import { IDLE_DELAY_MAX_MINUTES } from '@/api/contracts/idle-automation';
import { workspaceEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/** What the drawer asks to store - every field, every time. */
export interface IdleWrite {
  readonly reminderEnabled: boolean;
  readonly reminderDelayMinutes: number;
  readonly reminderMessage: string;
  readonly autoCloseEnabled: boolean;
  readonly autoCloseDelayMinutes: number;
  /** Empty: the conversation closes without a message. */
  readonly autoCloseMessage: string;
}

export type IdleWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'forbidden' | 'invalid' | 'failed' };

const delayOk = (minutes: number) =>
  Number.isInteger(minutes) && minutes >= 1 && minutes <= IDLE_DELAY_MAX_MINUTES;

/**
 * Saves follow-up and auto-close (S3). Owner only on the server.
 *
 * ★ THE WHOLE OBJECT, EVERY TIME: the PUT stores its body as the setting, so
 *   a field left out is erased. Delays and messages are kept while a part is
 *   switched off, so switching it back on restores them.
 * ★ A reminder that is on needs words: an empty message sends nothing.
 */
export async function saveIdleAutomation(write: IdleWrite): Promise<IdleWriteResult> {
  if (
    !delayOk(write.reminderDelayMinutes) ||
    !delayOk(write.autoCloseDelayMinutes) ||
    write.reminderMessage.length > 1000 ||
    write.autoCloseMessage.length > 1000 ||
    (write.reminderEnabled && write.reminderMessage.trim() === '')
  ) {
    return { ok: false, reason: 'invalid' };
  }
  try {
    await serverApi().put({
      endpoint: workspaceEndpoints.idleAutomation(),
      body: {
        reminderEnabled: write.reminderEnabled,
        reminderDelayMinutes: write.reminderDelayMinutes,
        reminderMessage: write.reminderMessage.trim(),
        autoCloseEnabled: write.autoCloseEnabled,
        autoCloseDelayMinutes: write.autoCloseDelayMinutes,
        autoCloseMessage: write.autoCloseMessage.trim(),
      },
      payload: z.unknown(),
    });
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('workspace.idle_save_failed', { cause });
    if (isApiError(cause) && cause.status === 403) return { ok: false, reason: 'forbidden' };
    if (isApiError(cause) && cause.kind === 'validation') return { ok: false, reason: 'invalid' };
    return { ok: false, reason: 'failed' };
  }
  revalidatePath('/[locale]/settings/workspace', 'page');
  return { ok: true };
}

/**
 * Saves the AI employee's groups that the reader changed - only those, each
 * whole (Supervisior, 2026-11-19): a group left untouched is never sent, so
 * saving never turns the platform's default into the business's own.
 */
export async function saveBotIdleAutomation(
  groups: Partial<Record<BotIdleGroupKey, BotIdleGroupWrite>>,
): Promise<IdleWriteResult> {
  const given = BOT_IDLE_GROUPS.filter((key) => groups[key]);
  if (given.length === 0) return { ok: false, reason: 'invalid' };
  if (given.some((key) => botIdleGroupProblem(groups[key]!) !== null)) {
    return { ok: false, reason: 'invalid' };
  }
  try {
    await serverApi().put({
      endpoint: workspaceEndpoints.botIdleAutomation(),
      body: botIdleBody(groups),
      payload: z.unknown(),
    });
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('workspace.bot_idle_save_failed', { cause });
    if (isApiError(cause) && cause.status === 403) return { ok: false, reason: 'forbidden' };
    if (isApiError(cause) && cause.kind === 'validation') return { ok: false, reason: 'invalid' };
    return { ok: false, reason: 'failed' };
  }
  revalidatePath('/[locale]/settings/workspace', 'page');
  return { ok: true };
}
