import 'server-only';

import { serverApi } from '@/api/client/server-api';
import { currentUserSchema } from '@/api/contracts/identity';
import { integrationsSchema } from '@/api/contracts/integrations';
import { websiteWidgetSchema } from '@/api/contracts/website-widget';
import { authEndpoints, channelEndpoints, integrationEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

export interface WooConnectRead {
  /** The workspace being connected; `null` when unread. */
  readonly workspace: string | null;
  /**
   * The workspace's WooCommerce store, when it is connected - the one the
   * plugin's site must be (§2.3). `'none'`: not connected; `null`: unread.
   */
  readonly store: string | 'none' | null;
  /** Does the workspace have its web chat? `null`: unread (binding will say). */
  readonly hasWidget: boolean | null;
}

/** What the connect page needs to say before anything is pressed. */
export async function loadWooConnect(): Promise<WooConnectRead> {
  const api = serverApi();
  const [workspace, store, hasWidget] = await Promise.all([
    api
      .get({ endpoint: authEndpoints.me(), payload: currentUserSchema })
      .then((me) => me.tenantName?.trim() || null)
      .catch(() => null),
    api
      .get({ endpoint: integrationEndpoints.list(), payload: integrationsSchema })
      .then((list) => {
        const connection = list.find((i) => i.slug === 'woocommerce')?.tenantConnection ?? null;
        // Connected with no address we can read: unknown - binding says.
        return connection?.status === 'CONNECTED' ? (connection.storeUrl ?? null) : 'none';
      })
      .catch((cause: unknown) => {
        logger.warn('woo_connect.integrations_failed', { cause });
        return null;
      }),
    api
      .get({ endpoint: channelEndpoints.websiteWidget(), payload: websiteWidgetSchema, raw: true })
      .then((r) => r.data.places.code !== null)
      .catch(() => null),
  ]);
  return { workspace, store, hasWidget };
}
