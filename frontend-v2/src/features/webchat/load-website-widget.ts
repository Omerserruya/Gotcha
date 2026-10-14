import 'server-only';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { onboardingStatusSchema, type OnboardingStatus } from '@/api/contracts/onboarding';
import { integrationsSchema, isFailing } from '@/api/contracts/integrations';
import {
  websiteWidgetSchema,
  widgetAssignmentSchema,
  widgetInstallSchema,
  type WebsiteWidget,
  type WidgetAssignment,
  type WidgetInstall,
} from '@/api/contracts/website-widget';
import {
  channelEndpoints,
  integrationEndpoints,
  onboardingEndpoints,
} from '@/api/endpoints/registry';
import {
  loadShopifyAvailability,
  type ShopifyAvailability,
} from '@/features/capabilities/load-capabilities';
import { logger } from '@/observability/logger';

/**
 * Shopify's DATA connection - the Admin API integration, a different record
 * from the chat installed in a shop. Both can be true at once in opposite
 * directions (dev: the chat CONNECTED, the integration ERROR on a token
 * refresh), so the Install tab never says "connected to stock and orders"
 * from the chat's state.
 *
 *   ok       connected and nothing failing
 *   failing  connected, and its status or its last test says it is broken
 *   none     not connected (or not finished connecting)
 */
export type ShopifyData = 'ok' | 'failing' | 'none';

export interface WebsiteWidgetRead {
  /** `null`: the settings could not be read - never a default widget. */
  readonly widget: WebsiteWidget | null;
  /** `null`: the installs could not be read. */
  readonly install: WidgetInstall | null;
  /** `null`: the integrations could not be read. */
  readonly shopifyData: ShopifyData | null;
  /** How "Install on Shopify" starts; read only on the Install tab. */
  readonly shopifyAvailability: ShopifyAvailability | null;
  /** The business's name - the preview's logo and launcher, as the design draws them. */
  readonly business: string | null;
}

/**
 * The business's display name: the business profile's organizationName,
 * else the workspace's name - the bootstraps' widget.brand rule (Backend
 * ef8ce568), so the preview and the live widget show the same brand.
 */
export function businessName(
  status: Pick<OnboardingStatus, 'tenant' | 'businessProfile'>,
): string | null {
  return status.businessProfile?.organizationName?.trim() || status.tenant.name?.trim() || null;
}

export async function loadWebsiteWidget({
  installTab,
}: {
  readonly installTab: boolean;
}): Promise<WebsiteWidgetRead> {
  const api = serverApi();
  const [widget, install, shopifyData, shopifyAvailability, business] = await Promise.all([
    api
      .get({ endpoint: channelEndpoints.websiteWidget(), payload: websiteWidgetSchema, raw: true })
      .then((r) => r.data)
      .catch((cause: unknown) => {
        logger.warn('website_widget.read_failed', { cause });
        return null;
      }),
    loadWidgetInstall(),
    api
      .get({ endpoint: integrationEndpoints.list(), payload: integrationsSchema })
      .then((list): ShopifyData => {
        const connection = list.find((i) => i.slug === 'shopify')?.tenantConnection ?? null;
        if (!connection) return 'none';
        if (isFailing(connection) || connection.status === 'DISCONNECTED') return 'failing';
        return connection.status === 'CONNECTED' ? 'ok' : 'none';
      })
      .catch((cause: unknown) => {
        logger.warn('website_widget.integrations_failed', { cause });
        return null;
      }),
    installTab ? loadShopifyAvailability() : Promise.resolve(null),
    // `raw`: the schema is the whole `{ data }` body; without it the client
    // unwraps `data` first and every read failed into the assistant's name (dev).
    api
      .get({ endpoint: onboardingEndpoints.status(), payload: onboardingStatusSchema, raw: true })
      .then((status) => businessName(status.data))
      .catch((cause: unknown) => {
        logger.warn('website_widget.business_name_failed', { cause });
        return null;
      }),
  ]);
  return { widget, install, shopifyData, shopifyAvailability, business };
}

/** Where the widget is installed - also the channels list's status for its one row. */
export async function loadWidgetInstall(): Promise<WidgetInstall | null> {
  return serverApi()
    .get({
      endpoint: channelEndpoints.websiteWidgetInstall(),
      payload: widgetInstallSchema,
      raw: true,
    })
    .then((r) => r.data)
    .catch((cause: unknown) => {
      logger.warn('website_widget.install_failed', { cause });
      return null;
    });
}

/**
 * Who answers the widget, per the playbook, and whom it can be given to
 * (§4.1). Admins only, like the playbook editor: `'forbidden'` for anyone
 * else - the card then reads it and says who can change it. `null`: it
 * could not be read, and nothing is offered.
 */
export async function loadWidgetAssignment(): Promise<WidgetAssignment | 'forbidden' | null> {
  try {
    const answer = await serverApi().get({
      endpoint: channelEndpoints.websiteWidgetAssignment(),
      payload: widgetAssignmentSchema,
      raw: true,
    });
    return answer.data;
  } catch (cause) {
    if (isApiError(cause) && cause.status === 403) return 'forbidden';
    logger.warn('website_widget.assignment_read_failed', { cause });
    return null;
  }
}
