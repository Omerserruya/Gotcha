import 'server-only';

import { serverApi } from '@/api/client/server-api';
import { channelStatesSchema } from '@/api/contracts/channels';
import { integrationsSchema, isConnected } from '@/api/contracts/integrations';
import { channelEndpoints, integrationEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

import { filterChips, type FilterChip, type QueueChannelFilter } from './inbox-views';

/**
 * The filter row's chips (I2): the workspace's channels with their state
 * (`/api/channels/state`, any member), and whether a WooCommerce store is
 * connected, beside the list. A channel read that fails gives the row as it
 * was; an integrations read that fails gives web chat its own globe.
 */
export async function loadFilterChips(
  current: QueueChannelFilter | null,
): Promise<readonly FilterChip[]> {
  const api = serverApi();
  const [states, integrations] = await Promise.all([
    api
      .get({ endpoint: channelEndpoints.state(), payload: channelStatesSchema })
      .catch((cause: unknown) => {
        logger.warn('inbox.channel_state_failed', { cause });
        return null;
      }),
    api
      .get({ endpoint: integrationEndpoints.list(), payload: integrationsSchema })
      .catch((cause: unknown) => {
        logger.warn('inbox.integrations_failed', { cause });
        return null;
      }),
  ]);
  const woo = integrations?.find((entry) => entry.slug === 'woocommerce');
  return filterChips(states, woo ? isConnected(woo) : false, current);
}
