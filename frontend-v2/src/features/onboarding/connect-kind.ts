import type { Integration } from '@/api/contracts/integrations';
import { oauthHere } from '@/features/capabilities/oauth';

/**
 * How a system connects from step 2 - the same rules as `ConnectFor`
 * (Studio · Capabilities), named so the step can say what to expect:
 *
 *   shopify  the install, started from Shopify
 *   woo      the store's own approval, by its address
 *   oauth    at the provider, back here
 *   form     a key form, right here
 *   none     not from here (the step does not show it)
 */
export type ConnectKind = 'shopify' | 'woo' | 'oauth' | 'form' | 'none';

export function connectKind(integration: Integration, reconnect: boolean): ConnectKind {
  const { oauth, fields } = integration.authSchema;
  if (integration.slug === 'shopify' && !reconnect) return 'shopify';
  if (integration.slug === 'woocommerce') return 'woo';
  if (!oauth && fields.length > 0) return 'form';
  if ((oauth || integration.slug === 'shopify') && oauthHere(integration.slug, reconnect)) {
    return 'oauth';
  }
  return 'none';
}

/** The store platforms: connecting one is what lets GOTCHA check an order. */
export const STORE_SYSTEMS: readonly string[] = ['shopify', 'woocommerce', 'wix', 'magento'];
