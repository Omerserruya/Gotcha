import { Plug } from 'lucide-react';

import { appPath } from '@/lib/base-path';

import styles from './Capabilities.module.css';

/**
 * Each provider's mark, shipped with the app in `public/integrations/` —
 * copied from ChatCenter's `integration-logos.ts` (Omer, 2026-10-04), so a
 * logo never depends on a third party's CDN path and `img-src 'self'` covers
 * it. Wordmarks (PayPal, HubSpot, Stripe, Zoho) were swapped for the square
 * mark: a wordmark in a 22px tile is a sliver.
 *
 * A provider with no entry — `custom_api`, or one added to the catalogue
 * later — gets the plug, never a wrong logo.
 */
export const INTEGRATION_LOGOS: Readonly<Record<string, string>> = {
  shopify: 'shopify.svg',
  woocommerce: 'woocommerce.svg',
  fireberry: 'fireberry.png',
  stripe: 'stripe.png',
  paypal: 'paypal.png',
  hubspot: 'hubspot.png',
  salesforce: 'salesforce.svg',
  zoho_crm: 'zoho_crm.png',
  monday: 'monday.svg',
  google_calendar: 'google_calendar.svg',
  returngo: 'returngo.png',
  postgresql: 'postgresql.svg',
  mongodb: 'mongodb.svg',
  aws_rds: 'aws_rds.svg',
  airtable: 'airtable.png',
  // 08b's knowledge sources. Confluence has no mark in the old app either: the plug.
  google_drive: 'google_drive.svg',
};

/** The tile 10 draws for a system: its mark, or the plug. Decorative — the name is beside it. */
export function IntegrationLogo({
  slug,
  size,
}: {
  /** `null` for GOTCHA's own built-in actions. */
  readonly slug: string | null;
  readonly size: 'rail' | 'head';
}) {
  const file = slug ? INTEGRATION_LOGOS[slug] : undefined;
  return (
    <span
      className={size === 'rail' ? styles.railTile : styles.systemTile}
      aria-hidden="true"
      data-logo={file ? slug : 'none'}
    >
      {file ? (
        // A 1–9 KB local mark: `next/image` would optimise nothing here.
        // eslint-disable-next-line @next/next/no-img-element
        <img className={styles.logo} src={appPath(`/integrations/${file}`)} alt="" />
      ) : (
        <Plug className={styles.logoIcon} size={size === 'rail' ? 12 : 18} strokeWidth={1.8} />
      )}
    </span>
  );
}
