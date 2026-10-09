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
 */
export function ConnectFor({
  integration,
  shopify = null,
  drawn,
}: {
  readonly integration: Integration;
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
      {integration.slug === 'shopify' ? (
        <ShopifyConnect mode={shopify?.mode ?? null} helpUrl={shopify?.helpUrl ?? null} />
      ) : integration.slug === 'woocommerce' ? (
        // B: the store's own approval replaces the key form.
        <WooConnect name={integration.name} />
      ) : !oauth && fields.length > 0 ? (
        <ConnectForm slug={integration.slug} name={integration.name} fields={fields} />
      ) : oauth && oauthHere(integration.slug, false) ? (
        <OAuthButton slug={integration.slug} name={integration.name} mode="connect" />
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
