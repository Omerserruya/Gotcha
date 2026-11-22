'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import {
  appLinkBody,
  consoleRefusalOf,
  expiryOf,
  isShopifyInstallLink,
  linkSentSchema,
  type AppLink,
  type ConsoleRefusal,
  type PrivateAppsSettings,
} from '@/api/contracts/shopify-private-apps';
import { consoleEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

export type ConsoleWrite =
  | {
      readonly ok: true;
      /** link and new-link: whether the email went out. Absent for the other steps. */
      readonly emailed?: boolean;
    }
  | { readonly ok: false; readonly reason: ConsoleRefusal };

const PAGE = '/[locale]/system/shopify-apps';

/*
 * ★★ Every catch logs the status alone. The link call carries the client
 * secret, and nothing that might hold the request is written anywhere.
 */
function refused(cause: unknown, event: string): ConsoleWrite {
  const status = isApiError(cause) ? cause.status : undefined;
  const code = isApiError(cause) ? cause.developerMessage : undefined;
  logger.warn(event, { status, code });
  return { ok: false, reason: consoleRefusalOf(status, code) };
}

/** The platform switch and who gets it (included in a plan, or granted by hand). */
export async function saveShopifyPrivateAppsSettings(
  settings: PrivateAppsSettings,
): Promise<ConsoleWrite> {
  try {
    await serverApi().put({
      endpoint: consoleEndpoints.shopifyPrivateAppsSettings(),
      payload: z.unknown(),
      body: { enabled: settings.enabled, entitlement: settings.entitlement },
      raw: true,
    });
    revalidatePath(PAGE, 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    return refused(cause, 'console.shopify_private_settings_failed');
  }
}

/** Stores the custom app (client id, secret, install link) and emails the merchant the link. */
export async function sendShopifyCustomAppLink(
  tenantId: string,
  form: AppLink,
): Promise<ConsoleWrite> {
  const body = appLinkBody(form);
  if (!body.clientId || !body.clientSecret || !isShopifyInstallLink(body.installLink)) {
    return { ok: false, reason: 'invalid_link' };
  }
  try {
    const sent = await serverApi().post({
      endpoint: consoleEndpoints.shopifyCustomAppStep(tenantId, 'link'),
      payload: linkSentSchema,
      body,
    });
    revalidatePath(PAGE, 'page');
    return { ok: true, emailed: sent.emailed };
  } catch (cause) {
    await signInIfSignedOut(cause);
    return refused(cause, 'console.shopify_custom_app_link_failed');
  }
}

/** A new install link for the same app, emailed. */
export async function sendShopifyCustomAppNewLink(
  tenantId: string,
  installLink: string,
  linkExpiresAt: string,
): Promise<ConsoleWrite> {
  if (!isShopifyInstallLink(installLink)) return { ok: false, reason: 'invalid_link' };
  try {
    const sent = await serverApi().post({
      endpoint: consoleEndpoints.shopifyCustomAppStep(tenantId, 'new-link'),
      payload: linkSentSchema,
      body: { installLink: installLink.trim(), ...expiryOf(linkExpiresAt) },
    });
    revalidatePath(PAGE, 'page');
    return { ok: true, emailed: sent.emailed };
  } catch (cause) {
    await signInIfSignedOut(cause);
    return refused(cause, 'console.shopify_custom_app_new_link_failed');
  }
}

/** Revoke, or grant (entitlement "manual" only): one step, no body. */
export async function shopifyCustomAppStep(
  tenantId: string,
  step: 'revoke' | 'grant',
): Promise<ConsoleWrite> {
  try {
    await serverApi().post({
      endpoint: consoleEndpoints.shopifyCustomAppStep(tenantId, step),
      payload: z.unknown(),
      body: {},
      raw: true,
    });
    revalidatePath(PAGE, 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    return refused(cause, `console.shopify_custom_app_${step}_failed`);
  }
}
