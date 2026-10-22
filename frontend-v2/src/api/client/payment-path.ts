import 'server-only';

import { z } from 'zod';

import { serverApi } from '@/api/client/server-api';
import { checkoutEndpoints } from '@/api/endpoints/registry';
import { appPath } from '@/lib/base-path';

/**
 * Where an unpaid workspace pays: this app's checkout pages, in the
 * interface's language - the open checkout's page, else the checkout entry
 * page (which explains).
 *
 * A full URL path for `window.location`, so it carries the locale and the
 * mount point itself: no router adds them to a plain navigation, and the
 * locale-less `/checkout` would cost a redirect and lose the language.
 */
export async function paymentPath(locale: string): Promise<string> {
  const entry = appPath(`/${locale}/checkout`);
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
    return reference ? `${entry}/payment-required?ref=${encodeURIComponent(reference)}` : entry;
  } catch {
    return entry;
  }
}
