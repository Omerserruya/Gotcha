import 'server-only';

import { cookies } from 'next/headers';

import { serverApi } from '@/api/client/server-api';
import { shopifyConnectorSchema, type ShopifyConnector } from '@/api/contracts/shopify-connector';
import { billingEndpoints } from '@/api/endpoints/registry';
import { captureFixturesEnabled } from '@/features/security/capture-fixtures';
import { logger } from '@/observability/logger';

import { CONNECTOR_FIXTURES, type ConnectorFixture } from './connector-fixtures';

/** The capture's choice of Connector state, one per test (see `e2e/settings-billing-connector.spec.ts`). */
export const CONNECTOR_FIXTURE_COOKIE = 'e2e_connector_fixture';

/**
 * The Shopify Connector's snapshot, for the Billing page and the integration
 * screen alike - one read, one verdict (`connectorVerdict`).
 *
 * `null` is a failed read, said as one: never "not connected", which would
 * offer a store that IS connected a second Connect.
 *
 * ── THE CAPTURE SWITCH ──
 * Every Connector state has to be photographed, and the page is a server
 * component, so Playwright cannot intercept this read. Under the same gate as
 * the security capture (`E2E_SECURITY_FIXTURES=1` AND a loopback origin, fail
 * closed - `capture-fixtures.ts`) a cookie names the state from
 * `CONNECTOR_FIXTURES`. Anywhere else the cookie is ignored and the read is live.
 */
export async function loadShopifyConnector(): Promise<ShopifyConnector | null> {
  if (captureFixturesEnabled()) {
    const name = (await cookies()).get(CONNECTOR_FIXTURE_COOKIE)?.value;
    if (name && Object.hasOwn(CONNECTOR_FIXTURES, name)) {
      return CONNECTOR_FIXTURES[name as ConnectorFixture];
    }
  }
  return serverApi()
    .get({ endpoint: billingEndpoints.shopifyState(), payload: shopifyConnectorSchema })
    .catch((cause: unknown) => {
      logger.warn('billing.shopify_state_failed', { cause });
      return null;
    });
}
