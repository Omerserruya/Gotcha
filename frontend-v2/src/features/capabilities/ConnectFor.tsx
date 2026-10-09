import type { Integration } from '@/api/contracts/integrations';

import { ConnectForm } from './ConnectForm';
import { OAuthButton } from './OAuthButton';
import { ShopifyConnect } from './ShopifyConnect';
import { WooConnect } from './WooConnect';
import { oauthHere } from './oauth';
import styles from './Capabilities.module.css';

/**
 * How a system that is not connected connects - the catalogue's to say, and
 * one place for it: 10's own screen and onboarding's source of truth (00g).
 *
 *   Shopify      the install, started from Shopify (availability read first)
 *   WooCommerce  the store's own approval, by its address
 *   fields       a credentials form
 *   OAuth        at the provider, where the way back comes here
 *   neither      drawn, with why
 *
 * `reconnect` is the same flow for a connected system that broke (ERROR):
 * the form replaces the keys in place (`/connect` updates the row it finds),
 * OAuth re-authorises at the provider, and Shopify re-authorises the store
 * already connected rather than starting a new install.
 */
export function ConnectFor({
  integration,
  shopify = null,
  reconnect = false,
  drawn,
}: {
  readonly integration: Integration;
  /** A connected system whose connection broke - the way back, not a first connect. */
  readonly reconnect?: boolean;
  readonly shopify?: { readonly mode: string; readonly helpUrl: string | null } | null;
  /** The drawn button's words - the caller's catalogue (synchronous, so it renders nested). */
  readonly drawn: {
    readonly connect: string;
    readonly oauthNotHere: string;
    readonly noForm: string;
  };
}) {
  const { oauth, fields } = integration.authSchema;
  return (
    <>
      {integration.slug === 'shopify' && !reconnect ? (
        <ShopifyConnect mode={shopify?.mode ?? null} helpUrl={shopify?.helpUrl ?? null} />
      ) : integration.slug === 'woocommerce' ? (
        // B: the store's own approval replaces the key form.
        <WooConnect name={integration.name} />
      ) : !oauth && fields.length > 0 ? (
        <ConnectForm slug={integration.slug} name={integration.name} fields={fields} />
      ) : (oauth || integration.slug === 'shopify') && oauthHere(integration.slug, reconnect) ? (
        <OAuthButton
          slug={integration.slug}
          name={integration.name}
          mode={reconnect ? 'reconnect' : 'connect'}
        />
      ) : (
        <span
          className={styles.connectButton}
          aria-disabled="true"
          title={oauth ? drawn.oauthNotHere : drawn.noForm}
          data-testid="connect-drawn"
        >
          {drawn.connect}
        </span>
      )}
    </>
  );
}
