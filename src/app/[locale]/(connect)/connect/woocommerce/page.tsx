import { loadWooConnect } from '@/features/webchat/load-woo-connect';
import { WooConnectFlow } from '@/features/webchat/WooConnectFlow';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * The WooCommerce plugin's "Connect to GOTCHA" lands here
 * (woocommerce-plugin-v1 §2): `?site=&return=&nonce=` from WordPress, or
 * `?connected=1` / `?error=` back from the store's own approval - the flow
 * keeps the first across the second.
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = (await searchParams) ?? {};
  const one = (key: string) => (typeof q[key] === 'string' ? q[key] : null);
  const read = await loadWooConnect();
  return (
    <WooConnectFlow
      asked={{ site: one('site'), returnUrl: one('return'), nonce: one('nonce') }}
      back={one('connected') === '1' ? 'connected' : one('error')}
      {...read}
    />
  );
}

export const generateMetadata = pageMetadata('wooConnect.tabTitle', 'channels');
