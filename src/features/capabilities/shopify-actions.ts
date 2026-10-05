'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { integrationEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

import { cookieFrom, INTENT_COOKIE, PENDING_COOKIE } from './shopify-cookies';

export type ShopifyStart =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: 'forbidden' | 'failed' };

/**
 * "Connect Shopify": the backend mints an install intent and answers with
 * Shopify's page and the intent in a cookie. That cookie is set HERE on the
 * browser — same name, `/`, HttpOnly, Lax — or the way back from Shopify
 * would not know which workspace started it.
 */
export async function startShopifyInstall(): Promise<ShopifyStart> {
  let intent: ReturnType<typeof cookieFrom> = null;
  try {
    const { url } = await serverApi().get({
      endpoint: integrationEndpoints.shopifyStart(),
      payload: z.object({ url: z.string().url() }),
      raw: true,
      onResponseHeaders: (headers) => {
        intent = cookieFrom(headers.getSetCookie(), INTENT_COOKIE);
      },
    });
    if (new URL(url).protocol !== 'https:') return { ok: false, reason: 'failed' };
    const relayed = intent as ReturnType<typeof cookieFrom>;
    if (!relayed) {
      logger.warn('capabilities.shopify_no_intent', {});
      return { ok: false, reason: 'failed' };
    }
    (await cookies()).set(INTENT_COOKIE, relayed.value, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      ...(relayed.maxAge === undefined ? {} : { maxAge: relayed.maxAge }),
    });
    return { ok: true, url };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('capabilities.shopify_start_failed', { cause });
    if (isApiError(cause) && cause.status === 403) return { ok: false, reason: 'forbidden' };
    return { ok: false, reason: 'failed' };
  }
}

export type ShopifyClaim =
  /** `planSelectionUrl`: a plan is owed, and Shopify's page is where to choose it. */
  | { readonly ok: true; readonly planSelectionUrl: string | null }
  | {
      readonly ok: false;
      readonly reason:
        | 'another_store_connected'
        | 'shop_connected_to_another_workspace'
        | 'gone'
        | 'forbidden'
        | 'failed';
      readonly currentShop?: string | null;
    };

/**
 * Binds the store approved in Shopify to this workspace — and, with
 * `replace`, disconnects the one connected now. The pending install is the
 * browser's cookie, sent on; nothing in the URL or the page holds it.
 */
export async function claimShopifyInstall(replace: boolean): Promise<ShopifyClaim> {
  const store = await cookies();
  const pending = store.get(PENDING_COOKIE)?.value;
  if (!pending) return { ok: false, reason: 'gone' };
  try {
    const answer = await serverApi().post({
      endpoint: integrationEndpoints.shopifyClaim(),
      payload: claimAnswer,
      body: { replace },
      headers: { cookie: `${PENDING_COOKIE}=${encodeURIComponent(pending)}` },
      raw: true,
    });
    store.delete(PENDING_COOKIE);
    revalidatePath('/[locale]/(app)/studio/capabilities', 'page');
    return { ok: true, planSelectionUrl: answer.data.planSelectionUrl };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('capabilities.shopify_claim_failed', { cause });
    if (isApiError(cause)) {
      const current = cause.errorData?.currentShopDomain;
      if (cause.status === 404) return { ok: false, reason: 'gone' };
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
      if (cause.status === 409 && cause.developerMessage === 'another_store_connected') {
        return {
          ok: false,
          reason: 'another_store_connected',
          currentShop: typeof current === 'string' ? current : null,
        };
      }
      if (
        cause.status === 409 &&
        cause.developerMessage === 'shop_connected_to_another_workspace'
      ) {
        return { ok: false, reason: 'shop_connected_to_another_workspace' };
      }
      if (cause.status === 409) return { ok: false, reason: 'gone' };
    }
    return { ok: false, reason: 'failed' };
  }
}

/* Only an https page of Shopify's is somewhere to send a browser. */
const shopifyPage = z
  .string()
  .url()
  .refine((url) => new URL(url).protocol === 'https:')
  .nullable()
  .catch(null);

const claimAnswer = z.object({
  data: z.object({ planSelectionUrl: shopifyPage.optional().default(null) }).catch({
    planSelectionUrl: null,
  }),
});

const accessSnapshot = z.object({
  grantsAccess: z.boolean().catch(false),
  requiresPlanSelection: z.boolean().catch(false),
  planSelectionUrl: shopifyPage.optional().default(null),
  shopify: z
    .object({ state: z.string().catch('ERROR'), declined: z.boolean().catch(false).optional() })
    .catch({ state: 'ERROR' }),
});

export type ShopifyBillingCheck =
  | {
      readonly ok: true;
      readonly grantsAccess: boolean;
      readonly state: string;
      readonly declined: boolean;
      /** Set only when the SERVER says a plan is owed — never built here. */
      readonly planSelectionUrl: string | null;
    }
  | {
      readonly ok: false;
      readonly reason: 'unreachable' | 'mismatch' | 'not_connected' | 'forbidden' | 'failed';
    };

/**
 * Back from Shopify's plan page: ask the server what the subscription IS.
 * Arriving proves nothing — the URL is replayable — so the only outcome shown
 * is the one the server read from Shopify.
 */
export async function verifyShopifyBilling(shop: string | null): Promise<ShopifyBillingCheck> {
  try {
    const snapshot = await serverApi().post({
      endpoint: integrationEndpoints.shopifyBillingComplete(),
      payload: accessSnapshot,
      query: { shop: shop?.trim() || undefined },
      body: {},
    });
    revalidatePath('/[locale]/(app)/studio/capabilities', 'page');
    return {
      ok: true,
      grantsAccess: snapshot.grantsAccess,
      state: snapshot.shopify.state,
      declined: snapshot.shopify.declined ?? false,
      planSelectionUrl: snapshot.requiresPlanSelection ? snapshot.planSelectionUrl : null,
    };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('capabilities.shopify_billing_verify_failed', { cause });
    if (isApiError(cause)) {
      if (cause.status === 502) return { ok: false, reason: 'unreachable' };
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
      if (cause.developerMessage === 'shopify_shop_mismatch')
        return { ok: false, reason: 'mismatch' };
      if (cause.developerMessage === 'shopify_not_connected') {
        return { ok: false, reason: 'not_connected' };
      }
    }
    return { ok: false, reason: 'failed' };
  }
}
