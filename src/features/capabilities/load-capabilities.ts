import 'server-only';

import { cookies } from 'next/headers';
import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import {
  capabilityListSchema,
  toolUsageListSchema,
  type Capability,
  type ToolUsage,
} from '@/api/contracts/capabilities';
import { integrationsSchema, type Integration } from '@/api/contracts/integrations';
import {
  analyticsEndpoints,
  capabilityEndpoints,
  integrationEndpoints,
} from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

import { PENDING_COOKIE } from './shopify-cookies';

/**
 * What GOTCHA is allowed to do.
 *
 * `{ data }` enveloped. `null` is a failed read and never an empty list: the
 * difference on this screen is between "GOTCHA can do nothing" and "you
 * cannot see what it can do", which are not the same reassurance.
 */
export interface CapabilityData {
  readonly capabilities: readonly Capability[] | null;
  /**
   * How often each tool has actually run.
   *
   * `null` when the read failed — which is NOT "never used". The screen says
   * nothing about a tool's history rather than printing a zero, because
   * "used 0 times" is a claim and a failed read is not evidence for it.
   *
   * Degrades on its own: a permissions list that arrives without its usage
   * counts is still the screen's main answer.
   */
  readonly usage: readonly ToolUsage[] | null;
  /**
   * The catalogue behind screen 10's rail — connected and available in one
   * list, split on `tenantConnection`.
   *
   * `null` is a failed read. An empty array would mean the catalogue itself
   * is empty, which is a different and much stranger thing to report.
   */
  readonly integrations: readonly Integration[] | null;
}

export async function loadCapabilities(): Promise<CapabilityData> {
  const api = serverApi();

  const [capabilities, usage, integrations] = await Promise.all([
    api
      .get({ endpoint: capabilityEndpoints.list(), payload: capabilityListSchema })
      .catch((cause: unknown) => {
        logger.warn('capabilities.list_failed', { cause });
        return null;
      }),
    /*
     * ★ A DIFFERENT PERMISSION FROM THE ROW IT ANNOTATES.
     *
     * The permissions list needs none; this needs
     * `analytics:dashboard:read`. So somebody can legitimately see what
     * GOTCHA may do and not see how often it has done it — which is a 403,
     * caught here like any other failure, and renders as the counts simply
     * not being there rather than as an error on a working screen.
     */
    api
      .get({ endpoint: analyticsEndpoints.toolUsage(), payload: toolUsageListSchema })
      .catch((cause: unknown) => {
        logger.warn('capabilities.usage_failed', { cause });
        return null;
      }),
    /*
     * The published catalogue with this tenant's connection on each row, so
     * connected-versus-available is one read rather than two. Gated on
     * `integrations:connections:read`, a third permission again — each of
     * these three panels can fail on its own and the screen degrades to the
     * ones that answered.
     */
    api
      .get({ endpoint: integrationEndpoints.list(), payload: integrationsSchema })
      .catch((cause: unknown) => {
        logger.warn('capabilities.integrations_failed', { cause });
        return null;
      }),
  ]);

  return { capabilities, usage, integrations };
}

export interface ShopifyAvailability {
  readonly mode: 'listing' | 'not_published' | string;
  readonly helpUrl: string | null;
}

/** Before the button (backend 98676242): read-only, no intent minted. `null` when unread. */
export async function loadShopifyAvailability(): Promise<ShopifyAvailability | null> {
  return serverApi()
    .get({
      endpoint: integrationEndpoints.shopifyAvailability(),
      payload: z.object({
        mode: z.string(),
        helpUrl: z.string().url().nullable().catch(null).default(null),
      }),
    })
    .catch((cause: unknown) => {
      logger.warn('capabilities.shopify_availability_failed', { cause });
      return null;
    });
}

/**
 * The store waiting to be claimed (the browser's pending cookie, sent on):
 * its domain; `'gone'` when there is no approval to claim (no cookie, or the
 * route has none — expired or used); `null` when the read itself failed.
 */
export async function loadShopifyPending(): Promise<string | 'gone' | null> {
  const pending = (await cookies()).get(PENDING_COOKIE)?.value;
  if (!pending) return 'gone';
  return serverApi()
    .get({
      endpoint: integrationEndpoints.shopifyPending(),
      payload: z.object({ shopDomain: z.string() }),
      headers: { cookie: `${PENDING_COOKIE}=${encodeURIComponent(pending)}` },
    })
    .then((p) => p.shopDomain)
    .catch((cause: unknown) => {
      if (isApiError(cause) && (cause.status === 404 || cause.status === 410))
        return 'gone' as const;
      logger.warn('capabilities.shopify_pending_failed', { cause });
      return null;
    });
}
