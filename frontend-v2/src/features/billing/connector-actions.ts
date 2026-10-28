'use server';

import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { billingEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

export type PlanSelection =
  | { readonly ok: true; readonly url: string }
  | {
      readonly ok: false;
      readonly reason: 'forbidden' | 'not_connected' | 'unavailable' | 'failed';
    };

const planSelectionAnswer = z.object({
  url: z
    .string()
    .url()
    .refine((url) => new URL(url).protocol === 'https:'),
});

/**
 * "Choose Shopify plan": asks the server for Shopify's plan page for THIS
 * workspace's store and hands the URL back to be opened. The URL is the
 * server's, always - the app never builds a Shopify address, and never shows
 * a price or a GOTCHA card for the Connector: Shopify does both on its page.
 *
 * Moves no money and writes no billing row: the server only answers where to
 * go (and logs that it was asked). The plan is chosen and approved in Shopify.
 */
export async function chooseShopifyPlan(): Promise<PlanSelection> {
  try {
    const { url } = await serverApi().post({
      endpoint: billingEndpoints.shopifyPlanSelection(),
      payload: planSelectionAnswer,
      body: {},
    });
    return { ok: true, url };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('billing.shopify_plan_selection_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    if (isApiError(cause)) {
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
      if (cause.developerMessage === 'shopify_not_connected') {
        return { ok: false, reason: 'not_connected' };
      }
      if (cause.status === 503) return { ok: false, reason: 'unavailable' };
    }
    return { ok: false, reason: 'failed' };
  }
}
