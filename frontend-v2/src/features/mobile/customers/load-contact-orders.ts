import 'server-only';

import { getLocale } from 'next-intl/server';

import { serverApi } from '@/api/client/server-api';
import { customerOrdersSchema, type CustomerOrders } from '@/api/contracts/customer-orders';
import { customerEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/** The newest orders the profile lists; the rest are on the website. */
export const ORDERS_SHOWN = 10;

/**
 * One customer's orders by contact, for the phone's profile: the read the
 * inbox's wall makes (`loadWallPerson`), with its contract - one OrderCard
 * shape for WooCommerce and Shopify, and `source: null` with the reason when
 * no store was read.
 *
 * `null` is a failed read, never "no orders".
 */
export async function loadContactOrders(contactId: string): Promise<CustomerOrders | null> {
  try {
    return await serverApi().get({
      endpoint: customerEndpoints.contactOrders(contactId),
      query: { limit: ORDERS_SHOWN, locale: await getLocale() },
      payload: customerOrdersSchema,
      // `orders` beside `source`: the whole body is the contract.
      raw: true,
    });
  } catch (cause) {
    logger.warn('mobile.customer_orders_failed', { cause });
    return null;
  }
}
