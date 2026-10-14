'use server';

import { revalidatePath } from 'next/cache';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import {
  bodyOfWidget,
  promotionsAvailableSchema,
  websiteWidgetSchema,
  type StoreCoupon,
  widgetAssignmentWriteSchema,
  type WidgetAssignment,
  type WidgetSettings,
} from '@/api/contracts/website-widget';
import { channelEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

export type WidgetSave =
  | { readonly ok: true; readonly settings: WidgetSettings }
  /** `nowhere`: no place exists yet (409 WIDGET_NOT_CREATED) - the code is created first. */
  | { readonly ok: false; readonly reason: 'nowhere' | 'failed' }
  /** 422 WHATSAPP_NUMBER_NOT_FOUND: the number is not one of this workspace's (stage B). */
  | { readonly ok: false; readonly reason: 'number' }
  /** 422 WHATSAPP_KIND_NEEDS_NUMBER: a WhatsApp widget needs a number that can take it (W1). */
  | { readonly ok: false; readonly reason: 'kindNumber' }
  /** 400 COUPON_PERSONAL: a customer's own coupon cannot be a widget deal (Backend bd1fe183). */
  | { readonly ok: false; readonly reason: 'couponPersonal' };

/**
 * A change to the widget, written to every place it is installed. The answer
 * is what the route kept - it normalises (a colour that is not hex, an
 * address that is not https) - so the screen shows the stored value.
 *
 * PUT never creates a place (Backend, 2026-10-07): with none it answers 409
 * `WIDGET_NOT_CREATED`, which is "nothing to save to yet", not a failure.
 */
export async function saveWebsiteWidget(
  settings: WidgetSettings,
  stageB = false,
): Promise<WidgetSave> {
  try {
    const answer = await serverApi().put({
      endpoint: channelEndpoints.websiteWidget(),
      body: bodyOfWidget(settings, { stageB }),
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
    if (isApiError(cause) && cause.code === 'WHATSAPP_KIND_NEEDS_NUMBER') {
      return { ok: false, reason: 'kindNumber' };
    }
    if (isApiError(cause) && cause.code === 'COUPON_PERSONAL') {
      return { ok: false, reason: 'couponPersonal' };
    }
    if (isApiError(cause) && cause.code === 'WHATSAPP_NUMBER_NOT_FOUND') {
      return { ok: false, reason: 'number' };
    }
    logger.warn('website_widget.save_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { ok: false, reason: 'failed' };
  }
}

export type PromotionsRead =
  | {
      readonly ok: true;
      readonly connected: boolean;
      readonly currency: string | null;
      readonly coupons: readonly StoreCoupon[];
    }
  /** `unreachable`: 502 STORE_UNREACHABLE - the store did not answer. */
  | { readonly ok: false; readonly reason: 'unreachable' | 'failed' };

/** W9d: the store's coupons, for the picker (the first page: 100). */
export async function loadWidgetPromotions(): Promise<PromotionsRead> {
  try {
    const answer = await serverApi().get({
      endpoint: channelEndpoints.websiteWidgetPromotions(),
      payload: promotionsAvailableSchema,
      query: { page: 1 },
      raw: true,
    });
    return {
      ok: true,
      connected: answer.data.connected,
      currency: answer.data.currency,
      coupons: answer.data.coupons,
    };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause) && cause.code === 'STORE_UNREACHABLE')
      return { ok: false, reason: 'unreachable' };
    logger.warn('website_widget.promotions_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { ok: false, reason: 'failed' };
  }
}

export type AssignmentSave =
  | { readonly ok: true; readonly assignment: WidgetAssignment }
  /**
   * 409 PLAYBOOK_SHARED: the route also serves other channels; resend with
   * `includeShared` to change them too. Which ones is the read's `sharedWith`:
   * the error envelope keeps only the keys it declares, and this one is not.
   */
  | { readonly ok: false; readonly reason: 'shared' }
  /**
   * conditional - 409 PLAYBOOK_CONDITIONAL: conditions decide it now (the playbook changed since the read);
   * employee_gone - 422 EMPLOYEE_NOT_FOUND: not an active employee any more;
   * no_place - 409 WIDGET_NOT_CREATED / 422 NO_WIDGET_CHANNEL: nothing to route yet.
   */
  | {
      readonly ok: false;
      readonly reason: 'conditional' | 'employee_gone' | 'no_place' | 'forbidden' | 'failed';
    };

/**
 * Who answers the widget's `channels` - written to THE PLAYBOOK (§4.2): it
 * reaches live conversations at once, and the screen says so before.
 *
 * A 409 writes nothing - no channel half-changed - so every refusal here
 * leaves the playbook as it was.
 */
export async function saveWidgetAssignment(
  employeeId: string,
  channels: readonly string[],
  includeShared = false,
): Promise<AssignmentSave> {
  try {
    const answer = await serverApi().put({
      endpoint: channelEndpoints.websiteWidgetAssignment(),
      body: { employeeId, channels, ...(includeShared ? { includeShared: true } : {}) },
      payload: widgetAssignmentWriteSchema,
      raw: true,
    });
    revalidatePath('/[locale]/settings/channels', 'layout');
    const { changed: _changed, ...assignment } = answer.data;
    return { ok: true, assignment };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause)) {
      if (cause.code === 'PLAYBOOK_SHARED') return { ok: false, reason: 'shared' };
      if (cause.code === 'PLAYBOOK_CONDITIONAL') return { ok: false, reason: 'conditional' };
      if (cause.code === 'EMPLOYEE_NOT_FOUND') return { ok: false, reason: 'employee_gone' };
      if (cause.code === 'WIDGET_NOT_CREATED' || cause.code === 'NO_WIDGET_CHANNEL') {
        return { ok: false, reason: 'no_place' };
      }
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
    }
    logger.warn('website_widget.assignment_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { ok: false, reason: 'failed' };
  }
}
