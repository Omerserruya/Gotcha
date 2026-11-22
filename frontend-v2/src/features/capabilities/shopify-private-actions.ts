'use server';

import { revalidatePath } from 'next/cache';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import {
  merchantRequestSentSchema,
  myshopifyOf,
  requestRefusalOf,
  type MerchantRequest,
  type RequestRefusal,
} from '@/api/contracts/shopify-private-apps';
import { integrationEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

export type PrivateRequestResult =
  | { readonly ok: true; readonly request: MerchantRequest }
  | { readonly ok: false; readonly reason: RequestRefusal };

/**
 * Asks for a private app for one store (before the listing is live). The
 * address is checked here too: a value the screen let through is not trusted.
 */
export async function requestShopifyPrivateApp(raw: string): Promise<PrivateRequestResult> {
  const shopDomain = myshopifyOf(raw);
  if (!shopDomain) return { ok: false, reason: 'invalid_shop_domain' };
  try {
    const request = await serverApi().post({
      endpoint: integrationEndpoints.shopifyCustomAppRequest(),
      payload: merchantRequestSentSchema,
      body: { shopDomain },
    });
    revalidatePath('/[locale]', 'layout');
    return { ok: true, request };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('capabilities.shopify_private_request_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    if (!isApiError(cause)) return { ok: false, reason: 'failed' };
    return { ok: false, reason: requestRefusalOf(cause.status, cause.developerMessage) };
  }
}
