import 'server-only';

import { z } from 'zod';

import { serverApi } from '@/api/client/server-api';
import { checkoutEndpoints } from '@/api/endpoints/registry';

/** The old app's payment pages - at the site root, outside this app's base path. */
export const PAYMENT_PATH = '/checkout';
export const PAYMENT_REQUIRED_PATH = '/checkout/payment-required';

/**
 * Where an unpaid workspace pays, as the old app decides it: the open
 * checkout's page, else the checkout entry page (which explains).
 */
export async function paymentPath(): Promise<string> {
  try {
    const mine = await serverApi().get({
      endpoint: checkoutEndpoints.mine(),
      payload: z.object({
        data: z.looseObject({
          checkout: z.looseObject({ reference: z.string() }).nullable().catch(null),
        }),
      }),
      raw: true,
    });
    const reference = mine.data.checkout?.reference;
    return reference
      ? `${PAYMENT_REQUIRED_PATH}?ref=${encodeURIComponent(reference)}`
      : PAYMENT_PATH;
  } catch {
    return PAYMENT_PATH;
  }
}
