'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { voiceChannelEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

import { accountSidProblem } from './twilio';

const createdSchema = z.object({
  id: z.string().min(1),
  numbers: z
    .array(
      z.object({
        id: z.string().min(1),
        e164: z.string(),
        friendlyName: z.string().nullable().catch(null).default(null),
        isActive: z.boolean().catch(false).default(false),
      }),
    )
    .default([]),
});
export type CreatedVoiceChannel = z.infer<typeof createdSchema>;

export type VoiceCreateResult =
  | { readonly ok: true; readonly channel: CreatedVoiceChannel }
  | {
      readonly ok: false;
      readonly reason: 'invalid' | 'twilio' | 'not_offered' | 'forbidden' | 'failed';
    };

/**
 * Bring your own Twilio — the old app's three steps, inside 13's Connect
 * panel (no design of its own). Stores the account's credentials and reads
 * its numbers; nothing answers calls until a number is activated.
 */
export async function createVoiceChannel(input: {
  readonly friendlyName: string;
  readonly accountSid: string;
  readonly authToken: string;
}): Promise<VoiceCreateResult> {
  const friendlyName = input.friendlyName.trim();
  const accountSid = input.accountSid.trim();
  if (!friendlyName || !input.authToken || accountSidProblem(accountSid)) {
    return { ok: false, reason: 'invalid' };
  }
  try {
    const channel = await serverApi().post({
      endpoint: voiceChannelEndpoints.create(),
      payload: createdSchema,
      body: { friendlyName, accountSid, authToken: input.authToken },
    });
    revalidatePath('/[locale]/(app)/settings/channels', 'page');
    return { ok: true, channel };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('channels.voice_create_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    if (isApiError(cause)) {
      // Twilio refused the details (its own words are technical: not shown).
      if (cause.status === 502) return { ok: false, reason: 'twilio' };
      if (cause.status === 400) return { ok: false, reason: 'invalid' };
      if (cause.status === 404) return { ok: false, reason: 'not_offered' };
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
    }
    return { ok: false, reason: 'failed' };
  }
}

export type ActivationResult = {
  readonly activated: readonly string[];
  readonly failed: readonly string[];
};

/** Activates the chosen numbers one by one — each a write at Twilio; one failing stops none. */
export async function activateVoiceNumbers(
  channelId: string,
  numberIds: readonly string[],
): Promise<ActivationResult> {
  const activated: string[] = [];
  const failed: string[] = [];
  for (const numberId of numberIds) {
    try {
      await serverApi().post({
        endpoint: voiceChannelEndpoints.activate(channelId, numberId),
        payload: z.unknown(),
        raw: true,
      });
      activated.push(numberId);
    } catch (cause) {
      await signInIfSignedOut(cause);
      logger.warn('channels.voice_activate_failed', {
        status: isApiError(cause) ? cause.status : undefined,
      });
      failed.push(numberId);
    }
  }
  if (activated.length > 0) revalidatePath('/[locale]/(app)/settings/channels', 'page');
  return { activated, failed };
}
