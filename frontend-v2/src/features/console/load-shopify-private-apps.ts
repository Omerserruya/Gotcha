import 'server-only';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import {
  consoleListSchema,
  type ConsoleRequest,
  type PrivateAppsSettings,
} from '@/api/contracts/shopify-private-apps';
import { consoleEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

export interface ShopifyPrivateAppsRead {
  /** `null` when unread - never a switch that looks off. */
  readonly settings: PrivateAppsSettings | null;
  /** `null` when unread - never an empty list that looks true. */
  readonly requests: readonly ConsoleRequest[] | null;
}

const unread = (event: string) => (cause: unknown) => {
  logger.warn(event, { status: isApiError(cause) ? cause.status : undefined });
  return null;
};

export async function loadShopifyPrivateApps(): Promise<ShopifyPrivateAppsRead> {
  // One read: the list, with the settings beside `data` (beaecd42) - so raw.
  const list = await serverApi()
    .get({ endpoint: consoleEndpoints.shopifyCustomApps(), payload: consoleListSchema, raw: true })
    .catch(unread('console.shopify_custom_apps_unread'));
  return { settings: list?.settings ?? null, requests: list?.data ?? null };
}
