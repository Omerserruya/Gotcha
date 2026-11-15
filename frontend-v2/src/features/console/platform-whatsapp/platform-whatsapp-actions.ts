'use server';

import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import {
  PLATFORM_REFUSALS,
  type PlatformRefusal,
  type TemplateLanguage,
} from '@/api/contracts/platform-whatsapp';
import { platformWhatsAppEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * The console's writes on GOTCHA's alerts number (auth, SYSTEM_ADMIN only).
 * Every one is real: connect registers a number at Meta, submit sends a
 * template to Meta's review, a switch decides whether alerts go out. Mocked
 * in every test.
 *
 * A refusal is one of the route's codes (PLAN "Error codes"), each its own
 * sentence on screen; Meta's English message is never shown.
 */
export type PlatformWrite =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: PlatformRefusal | 'forbidden' | 'failed' };

/** After `signInIfSignedOut` in the catch: a 401 never reaches here. */
function refusalOf(cause: unknown, event: string): PlatformWrite & { ok: false } {
  if (isApiError(cause)) {
    // `{ error: code }` lands in developerMessage, `{ code }` in code.
    for (const candidate of [cause.code, cause.developerMessage]) {
      if (candidate && (PLATFORM_REFUSALS as readonly string[]).includes(candidate)) {
        return { ok: false, reason: candidate as PlatformRefusal };
      }
    }
    if (cause.kind === 'authorization') return { ok: false, reason: 'forbidden' };
  }
  logger.warn(event, { status: isApiError(cause) ? cause.status : undefined });
  return { ok: false, reason: 'failed' };
}

async function write(event: string, call: () => Promise<unknown>): Promise<PlatformWrite> {
  try {
    await call();
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    return refusalOf(cause, event);
  }
}

/**
 * Connect the number picked in Meta's window. The route refuses a tenant's
 * number or WABA (409), and more than one number with none picked (422).
 */
export async function connectPlatformNumber(
  code: string,
  picked: { readonly wabaId?: string; readonly phoneNumberId?: string },
): Promise<PlatformWrite> {
  return write('console.platform_whatsapp_connect_failed', () =>
    serverApi().post({
      endpoint: platformWhatsAppEndpoints.connect(),
      body: {
        code,
        ...(picked.wabaId ? { wabaId: picked.wabaId } : {}),
        ...(picked.phoneNumberId ? { phoneNumberId: picked.phoneNumberId } : {}),
      },
      payload: z.unknown(),
    }),
  );
}

/** Read Meta again: the token, the phone, the subscription. Writes only our row. */
export async function recheckPlatformNumber(): Promise<PlatformWrite> {
  return write('console.platform_whatsapp_recheck_failed', () =>
    serverApi().post({
      endpoint: platformWhatsAppEndpoints.recheck(),
      body: {},
      payload: z.unknown(),
    }),
  );
}

/**
 * Unlink (the default): alerts stop, the number stays registered and its
 * templates stay. `deregister` also takes the number off the Cloud API.
 */
export async function disconnectPlatformNumber(deregister: boolean): Promise<PlatformWrite> {
  return write('console.platform_whatsapp_disconnect_failed', () =>
    serverApi().post({
      endpoint: platformWhatsAppEndpoints.disconnect(),
      body: { deregister },
      payload: z.unknown(),
    }),
  );
}

/** Pull Meta's states into the rows. */
export async function syncPlatformTemplates(): Promise<PlatformWrite> {
  return write('console.platform_whatsapp_sync_failed', () =>
    serverApi().post({
      endpoint: platformWhatsAppEndpoints.syncTemplates(),
      body: {},
      payload: z.unknown(),
    }),
  );
}

/** Save an edit as the draft. Nothing reaches Meta. */
export async function savePlatformTemplate(
  eventType: string,
  lang: TemplateLanguage,
  body: string,
): Promise<PlatformWrite> {
  return write('console.platform_whatsapp_template_save_failed', () =>
    serverApi().put({
      endpoint: platformWhatsAppEndpoints.template(eventType, lang),
      body: { body },
      payload: z.unknown(),
    }),
  );
}

/** Send one template to Meta's review. Outward; asked first on screen. */
export async function submitPlatformTemplate(
  eventType: string,
  lang: TemplateLanguage,
): Promise<PlatformWrite> {
  return write('console.platform_whatsapp_template_submit_failed', () =>
    serverApi().post({
      endpoint: platformWhatsAppEndpoints.submitTemplate(eventType, lang),
      body: {},
      payload: z.unknown(),
    }),
  );
}

/** Whether one alert goes out on WhatsApp. Turning on needs both languages approved. */
export async function setPlatformAlert(
  eventType: string,
  enabled: boolean,
): Promise<PlatformWrite> {
  return write('console.platform_whatsapp_alert_failed', () =>
    serverApi().put({
      endpoint: platformWhatsAppEndpoints.alert(eventType),
      body: { enabled },
      payload: z.unknown(),
    }),
  );
}
