import { oauthFailure, type OAuthFailure } from '@/features/capabilities/oauth';

/**
 * The way back to step 2 from a provider (`flow=onboarding_systems`, signed
 * by the backend into the state), read off the query:
 *
 *   system=<slug>&connected=1                         connected
 *   system=<slug>&error=<code>                        not connected, and why
 *   system=shopify&pending=1&reason=replace_store     a store to claim
 *   system=shopify&error=shop_connected_elsewhere     (an error like any other)
 *   system=shopify&billing=verify&shop=<domain>       back from Shopify's plan page
 *
 * The same reading as Studio · Capabilities (`/studio/capabilities`), so a
 * code means the same thing on both screens. The query proves nothing by
 * itself: "connected" is shown beside the catalogue's own row, and billing is
 * only what the server reads back from Shopify.
 */
export type SystemsReturnQuery = {
  readonly system?: string;
  readonly connected?: string;
  readonly error?: string;
  readonly pending?: string;
  readonly reason?: string;
  readonly billing?: string;
  readonly shop?: string;
};

export type SystemsReturn =
  | { readonly kind: 'connected'; readonly slug: string }
  | { readonly kind: 'error'; readonly slug: string; readonly code: OAuthFailure | 'other' }
  | { readonly kind: 'pending'; readonly slug: 'shopify'; readonly replace: boolean }
  | { readonly kind: 'billing'; readonly slug: 'shopify'; readonly shop: string | null };

/** The query keys the way back carries - removed from the address once read. */
export const RETURN_KEYS = [
  'system',
  'connected',
  'error',
  'pending',
  'reason',
  'billing',
  'shop',
] as const;

/* A catalogue slug, never free text: it is looked up, and never printed. */
const SLUG = /^[a-z0-9_-]{1,64}$/;

export function systemsReturn(query: SystemsReturnQuery | undefined): SystemsReturn | null {
  const slug = query?.system?.trim().toLowerCase() ?? '';
  if (!SLUG.test(slug)) return null;
  if (slug === 'shopify' && query?.billing === 'verify') {
    return { kind: 'billing', slug, shop: query.shop?.trim() || null };
  }
  if (slug === 'shopify' && query?.pending === '1') {
    return { kind: 'pending', slug, replace: query.reason === 'replace_store' };
  }
  if (query?.connected === '1') return { kind: 'connected', slug };
  const code = oauthFailure(query?.error?.trim() || undefined);
  if (code) return { kind: 'error', slug, code };
  return null;
}
