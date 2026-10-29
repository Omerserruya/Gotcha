'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import { shopifyConnectorSchema, uninstallAnswerSchema } from '@/api/contracts/shopify-connector';
import {
  billingEndpoints,
  CONNECT_FLOWS,
  integrationEndpoints,
  type ConnectFlow,
} from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

import { cookieFrom, INTENT_COOKIE, PENDING_COOKIE } from './shopify-cookies';

export type ShopifyStart =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: 'forbidden' | 'core_plan_required' | 'failed' };

/**
 * "Connect Shopify": the backend mints an install intent and answers with
 * Shopify's page and the intent in a cookie. That cookie is set HERE on the
 * browser - same name, `/`, HttpOnly, Lax - or the way back from Shopify
 * would not know which workspace started it.
 */
export async function startShopifyInstall(
  /** Where Shopify's way back lands: Studio (default) or onboarding's step 2. */
  flow: ConnectFlow = 'redesign_studio',
): Promise<ShopifyStart> {
  if (!(CONNECT_FLOWS as readonly unknown[]).includes(flow)) return { ok: false, reason: 'failed' };
  let intent: ReturnType<typeof cookieFrom> = null;
  try {
    const { url } = await serverApi().get({
      endpoint: integrationEndpoints.shopifyStart(flow),
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
    // GOTCHA Core first (fix/split-billing-be): the server's refusal is the answer.
    if (isApiError(cause) && cause.developerMessage === 'core_plan_required') {
      return { ok: false, reason: 'core_plan_required' };
    }
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
        | 'core_plan_required'
        | 'failed';
      readonly currentShop?: string | null;
    };

/**
 * Binds the store approved in Shopify to this workspace - and, with
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
      if (cause.developerMessage === 'core_plan_required') {
        return { ok: false, reason: 'core_plan_required' };
      }
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
      // Used already: there is nothing left to claim.
      if (cause.status === 409 && cause.developerMessage === 'pending_install_already_used') {
        return { ok: false, reason: 'gone' };
      }
      // An unknown 409 is not proof the approval is gone: said as a failure, not as "expired".
      // 503 billing_link_failed lands here too - nothing was spent, so the button tries again.
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
      /** Set only when the SERVER says a plan is owed - never built here. */
      readonly planSelectionUrl: string | null;
    }
  | {
      readonly ok: false;
      readonly reason: 'unreachable' | 'mismatch' | 'not_connected' | 'forbidden' | 'failed';
    };

/**
 * Back from Shopify's plan page: ask the server what the subscription IS.
 * Arriving proves nothing - the URL is replayable - so the only outcome shown
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

export type ShopifyUninstall =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | 'not_connected'
        | 'no_token'
        | 'no_shop_domain'
        | 'shopify_refused'
        | 'forbidden'
        | 'failed';
    };

const UNINSTALL_REFUSALS = [
  'not_connected',
  'no_token',
  'no_shop_domain',
  'shopify_refused',
] as const;

/**
 * Disconnect Shopify for real: ask Shopify to uninstall the GOTCHA app.
 *
 * The answer is "asked", never "disconnected" (`awaiting_webhook`): only
 * Shopify's signed `app/uninstalled` webhook finishes it, and until then the
 * snapshot's `connector.status` is `uninstall_pending`. The old local
 * disconnect left the app installed and Shopify billing, while telling the
 * merchant they had disconnected.
 */
export async function uninstallShopify(): Promise<ShopifyUninstall> {
  try {
    await serverApi().post({
      endpoint: integrationEndpoints.shopifyUninstall(),
      payload: uninstallAnswerSchema,
      body: {},
    });
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    logger.warn('capabilities.shopify_uninstall_failed', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    if (isApiError(cause)) {
      if (cause.status === 403) return { ok: false, reason: 'forbidden' };
      const code = UNINSTALL_REFUSALS.find((r) => r === cause.developerMessage);
      if (code) return { ok: false, reason: code };
    }
    return { ok: false, reason: 'failed' };
  }
}

/**
 * The Connector's status as the server has it now, for the screen that is
 * waiting on Shopify's confirmation. `null` is a failed read: keep waiting.
 */
export async function readShopifyConnectorStatus(): Promise<string | null> {
  return serverApi()
    .get({ endpoint: billingEndpoints.shopifyState(), payload: shopifyConnectorSchema })
    .then((snapshot) => snapshot.connector?.status ?? null)
    .catch((cause: unknown) => {
      logger.warn('capabilities.shopify_state_failed', { cause });
      return null;
    });
}
