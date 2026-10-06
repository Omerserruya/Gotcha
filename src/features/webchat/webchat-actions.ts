'use server';

import { revalidatePath } from 'next/cache';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { z } from 'zod';

import { bodyOfConfig, webchatConfigSchema, type WebchatConfig } from '@/api/contracts/webchat';
import { channelEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * A change to the widget, merged into what is stored. The answer is what
 * the route kept - it normalises (a colour that is not hex, an address that
 * is not https) - so the screen shows the stored value, not the typed one.
 */
export async function saveWebchat(
  id: string,
  config: WebchatConfig,
): Promise<WebchatConfig | null> {
  try {
    const answer = await serverApi().put({
      endpoint: channelEndpoints.webchatSettings(id),
      body: bodyOfConfig(config),
      // The PUT answers the channel row with the stored config inside it.
      payload: z.object({ data: z.object({ config: webchatConfigSchema }) }),
      raw: true,
    });
    revalidatePath('/[locale]/settings/channels', 'layout');
    return answer.data.config;
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('webchat.save_failed', { status: isApiError(cause) ? cause.status : undefined });
    return null;
  }
}
