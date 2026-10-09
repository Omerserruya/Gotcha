'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { channelEndpoints, integrationEndpoints } from '@/api/endpoints/registry';
import { storeAddressOf } from '@/features/capabilities/oauth';
import { logger } from '@/observability/logger';

/**
 * The WooCommerce plugin's two writes from GOTCHA (woocommerce-plugin-v1,
 * Backend 1e90d585): linking a site from the connect page the plugin opens,
 * and removing one from the Install tab.
 */

export type WooBind =
  | { readonly ok: true; readonly redirect: string }
  | {
      readonly ok: false;
      readonly reason:
        'store_not_connected' | 'bad_return' | 'bad_nonce' | 'no_widget' | 'forbidden' | 'failed';
    };

/**
 * §2.3: a one-time code for the plugin, and the way back to WordPress.
 *
 * The web chat is created first when the workspace has none (`withWidget`):
 * the plugin loads the same widget the code snippet does, and binding
 * refuses a workspace without one.
 *
 * ★ The way back is checked here, not only by the route: it must be on the
 *   store's own address, as the plugin's settings page was. A redirect
 *   anywhere else is not followed - this page sends a signed-in browser on.
 */
export async function bindWooPlugin(
  link: { readonly site: string; readonly returnUrl: string; readonly nonce: string },
  { createWidget = false }: { readonly createWidget?: boolean } = {},
): Promise<WooBind> {
  try {
    if (createWidget) {
      await serverApi().post({
        endpoint: channelEndpoints.createWebChat(),
        payload: z.unknown(),
        body: {},
      });
    }
    const answer = await serverApi().post({
      endpoint: channelEndpoints.wooPluginBind(),
      body: { siteUrl: link.site, returnUrl: link.returnUrl, nonce: link.nonce },
      payload: z.object({ redirect: z.string() }),
    });
    if (!sameOrigin(answer.redirect, link.returnUrl)) {
      logger.warn('woo_plugin.redirect_elsewhere');
      return { ok: false, reason: 'failed' };
    }
    revalidatePath('/[locale]/settings/channels', 'layout');
    return { ok: true, redirect: answer.redirect };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause)) {
      if (cause.code === 'STORE_NOT_CONNECTED') return { ok: false, reason: 'store_not_connected' };
      if (cause.code === 'BAD_RETURN_URL') return { ok: false, reason: 'bad_return' };
      if (cause.code === 'BAD_NONCE') return { ok: false, reason: 'bad_nonce' };
      if (cause.code === 'WIDGET_NOT_CREATED') return { ok: false, reason: 'no_widget' };
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
    }
    logger.warn('woo_plugin.bind_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { ok: false, reason: 'failed' };
  }
}

function sameOrigin(a: string, b: string): boolean {
  if (!URL.canParse(a) || !URL.canParse(b)) return false;
  const x = new URL(a);
  return /^https?:$/.test(x.protocol) && x.origin === new URL(b).origin;
}

export type WooStoreStart =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: 'invalid_store' | 'forbidden' | 'failed' };

/**
 * The store's own approval first (the existing key flow, `flow=wp_plugin`):
 * it comes back to the connect page with `?connected=1` or `?error=`.
 */
export async function startWooPluginStore(site: string): Promise<WooStoreStart> {
  const storeUrl = storeAddressOf(site, process.env.NODE_ENV === 'production');
  if (!storeUrl) return { ok: false, reason: 'invalid_store' };
  try {
    const { url } = await serverApi().get({
      endpoint: integrationEndpoints.wooOAuthInitPlugin(storeUrl),
      payload: z.object({ url: z.string().url() }),
      raw: true,
    });
    // The store's own approval page: on the store, as the existing flow checks.
    const target = new URL(url);
    if (target.protocol !== 'https:' && target.protocol !== new URL(storeUrl).protocol) {
      return { ok: false, reason: 'failed' };
    }
    return { ok: true, url };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('woo_plugin.store_start_failed', { cause });
    if (isApiError(cause)) {
      if (cause.status === 400) return { ok: false, reason: 'invalid_store' };
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
    }
    return { ok: false, reason: 'failed' };
  }
}

export type WooRemove =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'gone' | 'forbidden' | 'failed' };

/** §4: revokes the site's key; its plugin shows "Not connected" on its next signal. */
export async function removeWooSite(id: string): Promise<WooRemove> {
  try {
    await serverApi().delete({
      endpoint: channelEndpoints.wooPluginSite(id),
      payload: z.unknown(),
    });
    revalidatePath('/[locale]/settings/channels', 'layout');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    if (isApiError(cause)) {
      if (cause.status === 404) return { ok: false, reason: 'gone' };
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
    }
    logger.warn('woo_plugin.remove_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return { ok: false, reason: 'failed' };
  }
}
