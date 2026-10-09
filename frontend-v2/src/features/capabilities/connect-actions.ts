'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { integrationsSchema } from '@/api/contracts/integrations';
import { integrationEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

import { credentialsFor } from './connect-form';
import { OAUTH_HERE, SALESFORCE_HOSTS, storeAddressOf } from './oauth';
import { signInIfSignedOut } from '@/api/client/signed-out';

export type ConnectResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /**
       * `missing` - a required field is empty or a choice is not one offered;
       * `not_here` - this system connects at its provider (OAuth) or not by a
       * form at all; `entitlement` · `forbidden` · `failed`.
       */
      readonly reason: 'missing' | 'not_here' | 'entitlement' | 'forbidden' | 'failed';
    }
  /** 422: the keys did not work; nothing was written. The sentence is the backend's, for the merchant. */
  | { readonly ok: false; readonly reason: 'validation'; readonly message: string | null };

/**
 * 10's Connect - live (Omer, 2026-10-04): `POST /api/integrations/:slug/connect`.
 *
 * The form's fields are read again HERE, from the catalogue, rather than
 * taken from the browser: what is sent is what the catalogue asks for and
 * nothing else a request could add.
 */
export async function connectIntegration(
  slug: string,
  values: Readonly<Record<string, string>>,
): Promise<ConnectResult> {
  const api = serverApi();
  try {
    const catalogue = await api.get({
      endpoint: integrationEndpoints.list(),
      payload: integrationsSchema,
    });
    const entry = catalogue.find((e) => e.slug === slug);
    if (!entry) return { ok: false, reason: 'failed' };
    if (entry.authSchema.oauth || entry.authSchema.fields.length === 0) {
      return { ok: false, reason: 'not_here' };
    }
    const credentials = credentialsFor(entry.authSchema.fields, values);
    if (credentials === null) return { ok: false, reason: 'missing' };

    await api.post({
      endpoint: integrationEndpoints.connect(slug),
      payload: z.object({ id: z.string() }),
      body: { credentials },
    });
    revalidatePath('/[locale]/(app)/studio/capabilities', 'page');
    revalidatePath('/[locale]/(app)/settings/systems', 'page');
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('capabilities.connect_failed', { slug, cause });
    if (isApiError(cause)) {
      if (cause.status === 400) return { ok: false, reason: 'missing' };
      if (cause.status === 422) {
        return { ok: false, reason: 'validation', message: cause.userMessage?.trim() || null };
      }
      if (cause.status === 402) return { ok: false, reason: 'entitlement' };
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
    }
    return { ok: false, reason: 'failed' };
  }
}

export type OAuthStart =
  | { readonly ok: true; readonly url: string }
  | {
      readonly ok: false;
      /**
       * `not_here` - this system does not come back here; `not_configured`
       * - the provider's app is not set up (500 *_not_configured);
       * `needs_store` - Shopify with no store connected yet (409);
       * `forbidden` · `failed`.
       */
      readonly reason: 'not_here' | 'not_configured' | 'needs_store' | 'forbidden' | 'failed';
    };

/**
 * 10's Connect for an OAuth system (Omer, 2026-10-04; backend 381a5d1b):
 * `GET /api/connectors/:slug/oauth/init?flow=redesign_studio` - server-side,
 * with the session - then the browser goes to the provider's page. Nothing
 * is connected until the person approves there; the way back lands on this
 * system's screen with `connected=1` or `error=<code>`.
 */
export async function startOAuth(slug: string, loginHost?: string): Promise<OAuthStart> {
  if (!OAUTH_HERE[slug]) return { ok: false, reason: 'not_here' };
  if (loginHost !== undefined && (slug !== 'salesforce' || !SALESFORCE_HOSTS.includes(loginHost))) {
    return { ok: false, reason: 'failed' };
  }
  try {
    const { url } = await serverApi().get({
      endpoint: integrationEndpoints.oauthInit(slug, loginHost),
      payload: z.object({ url: z.string().url() }),
      raw: true,
    });
    // The provider's page, and only over https.
    if (new URL(url).protocol !== 'https:') return { ok: false, reason: 'failed' };
    return { ok: true, url };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('capabilities.oauth_start_failed', { slug, cause });
    if (isApiError(cause)) {
      if (cause.status === 409) return { ok: false, reason: 'needs_store' };
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
      if (cause.status === 500 && /not_configured/.test(cause.developerMessage ?? '')) {
        return { ok: false, reason: 'not_configured' };
      }
    }
    return { ok: false, reason: 'failed' };
  }
}

export type WooStart =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: 'invalid_store' | 'forbidden' | 'failed' };

/** B: WooCommerce through the store's own approval page. Nothing is connected before it. */
export async function startWooOAuth(raw: string): Promise<WooStart> {
  const storeUrl = storeAddressOf(raw, process.env.NODE_ENV === 'production');
  if (!storeUrl) return { ok: false, reason: 'invalid_store' };
  try {
    const { url } = await serverApi().get({
      endpoint: integrationEndpoints.wooOAuthInit(storeUrl),
      payload: z.object({ url: z.string().url() }),
      raw: true,
    });
    // The store's own approval page: https, or the store's own scheme outside production.
    const target = new URL(url);
    if (target.protocol !== 'https:' && target.protocol !== new URL(storeUrl).protocol) {
      return { ok: false, reason: 'failed' };
    }
    return { ok: true, url };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('capabilities.woo_start_failed', { cause });
    if (isApiError(cause)) {
      if (cause.status === 400) return { ok: false, reason: 'invalid_store' };
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
    }
    return { ok: false, reason: 'failed' };
  }
}
