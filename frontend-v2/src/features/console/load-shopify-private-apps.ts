import 'server-only';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import {
  consoleRequestsSchema,
  privateAppsSettingsSchema,
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
  const [settings, requests] = await Promise.all([
    serverApi()
      .get({
        endpoint: consoleEndpoints.shopifyPrivateAppsSettings(),
        payload: privateAppsSettingsSchema,
      })
      .catch(unread('console.shopify_private_settings_unread')),
    serverApi()
      .get({ endpoint: consoleEndpoints.shopifyCustomApps(), payload: consoleRequestsSchema })
      .catch(unread('console.shopify_custom_apps_unread')),
  ]);
  return { settings, requests };
}
