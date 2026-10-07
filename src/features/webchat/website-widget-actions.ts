'use server';

import { revalidatePath } from 'next/cache';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import {
  bodyOfWidget,
  websiteWidgetSchema,
  type WidgetSettings,
} from '@/api/contracts/website-widget';
import { channelEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

export type WidgetSave =
  | { readonly ok: true; readonly settings: WidgetSettings }
  /** `nowhere`: no place exists yet (409 WIDGET_NOT_CREATED) - the code is created first. */
  | { readonly ok: false; readonly reason: 'nowhere' | 'failed' };

/**
 * A change to the widget, written to every place it is installed. The answer
 * is what the route kept - it normalises (a colour that is not hex, an
 * address that is not https) - so the screen shows the stored value.
 *
 * PUT never creates a place (Backend, 2026-10-07): with none it answers 409
 * `WIDGET_NOT_CREATED`, which is "nothing to save to yet", not a failure.
 */
export async function saveWebsiteWidget(settings: WidgetSettings): Promise<WidgetSave> {
  try {
    const answer = await serverApi().put({
      endpoint: channelEndpoints.websiteWidget(),
      body: bodyOfWidget(settings),
      payload: websiteWidgetSchema,
      raw: true,
    });
    revalidatePath('/[locale]/settings/channels', 'layout');
    return { ok: true, settings: answer.data.settings };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause) && cause.status === 409 && cause.code === 'WIDGET_NOT_CREATED') {
      return { ok: false, reason: 'nowhere' };
    }
    logger.warn('website_widget.save_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { ok: false, reason: 'failed' };
  }
}
