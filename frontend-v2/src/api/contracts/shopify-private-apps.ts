import { z } from 'zod';

/**
 * Shopify private (custom-distribution) apps (Supervisor, 2026-11-22): before
 * the App Store listing is live, a merchant asks for their store; a system
 * admin creates a custom app for it in the Partner Dashboard, pastes its
 * client id, secret and install link, and GOTCHA emails the merchant.
 *
 * Backend's draft contract (feat/shopify-custom-app, 2026-11-22):
 *
 * MERCHANT
 *   GET  /api/connectors/shopify/install/availability → mode "custom_app_request"
 *        (listing not live, switch on, no store)
 *   GET  /api/connectors/shopify/custom-app/request
 *        → { data: { status, shopDomain, linkExpiresAt, installLink? } | null }
 *        installLink only while link_sent and not expired
 *   POST /api/connectors/shopify/custom-app/request { shopDomain }
 *        → 201 { data: { status: "requested", shopDomain } }
 *        400 invalid_shop_domain · 409 already_requested | shop_requested_elsewhere
 *        | store_connected · 403 private_apps_off
 * CONSOLE (system admin)
 *   GET  /api/system/shopify-custom-apps
 *        → { data: [{ tenantId, tenantName, status, shopDomain, requestedAt,
 *                     linkExpiresAt, installedAt, clientId }] }
 *   POST /api/system/shopify-custom-apps/:tenantId/link
 *        { clientId, clientSecret, installLink, linkExpiresAt? } → 200, merchant emailed
 *        409 wrong state · 400 the link is not https on admin.shopify.com
 *   POST …/:tenantId/new-link { installLink, linkExpiresAt? } · …/revoke · …/grant
 *        (grant only with entitlement "manual")
 *   GET/PUT /api/system/shopify-private-apps { enabled, entitlement: included | manual }
 *
 * ★★ The client secret goes one way: typed, sent once, never read back,
 *   never logged, cleared from the page after the send.
 */

export const CUSTOM_APP_MODE = 'custom_app_request';

export const REQUEST_STATES = ['requested', 'link_sent', 'installed', 'revoked'] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

/** A store's address as Shopify issues it: `<name>.myshopify.com`, nothing else. */
export const MYSHOPIFY = /^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$/;

/**
 * What the merchant typed, made into a store address: trimmed, lowercased,
 * `https://` and any path dropped, `.myshopify.com` added to a bare name.
 * `null` when it still is not one - never sent.
 */
export function myshopifyOf(raw: string): string | null {
  let value = raw.trim().toLowerCase();
  value = value.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (value && !value.includes('.')) value = `${value}.myshopify.com`;
  return MYSHOPIFY.test(value) ? value : null;
}

/** Only Shopify's own admin page is a link we send a person to, or email. */
export function isShopifyInstallLink(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'admin.shopify.com';
  } catch {
    return false;
  }
}

const when = z.string().nullable().catch(null).default(null);
const installLink = z
  .string()
  .nullable()
  .catch(null)
  .default(null)
  .transform((v) => (v !== null && isShopifyInstallLink(v) ? v : null));

/** The merchant's own request; a state we do not know is no card, never a guess. */
export const merchantRequestSchema = z.looseObject({
  status: z.enum(REQUEST_STATES),
  shopDomain: z.string().min(1),
  linkExpiresAt: when,
  installLink,
});
export type MerchantRequest = z.infer<typeof merchantRequestSchema>;

export const merchantRequestReadSchema = merchantRequestSchema.nullable();

export type RequestRefusal =
  | 'invalid_shop_domain'
  | 'already_requested'
  | 'shop_requested_elsewhere'
  | 'store_connected'
  | 'private_apps_off'
  | 'forbidden'
  | 'failed';

export function requestRefusalOf(
  status: number | undefined,
  code: string | undefined,
): RequestRefusal {
  if (code === 'invalid_shop_domain' || status === 400 || status === 422)
    return 'invalid_shop_domain';
  if (code === 'already_requested') return 'already_requested';
  if (code === 'shop_requested_elsewhere') return 'shop_requested_elsewhere';
  if (code === 'store_connected') return 'store_connected';
  if (code === 'private_apps_off') return 'private_apps_off';
  if (status === 403) return 'forbidden';
  return 'failed';
}

/* ── The console ─────────────────────────────────────────────────────────── */

export const ENTITLEMENTS = ['included', 'manual'] as const;
export type Entitlement = (typeof ENTITLEMENTS)[number];

export const privateAppsSettingsSchema = z.looseObject({
  enabled: z.boolean(),
  entitlement: z.enum(ENTITLEMENTS).catch('included'),
});
export type PrivateAppsSettings = z.infer<typeof privateAppsSettingsSchema>;

export const consoleRequestSchema = z.looseObject({
  tenantId: z.string().min(1),
  tenantName: z.string().nullable().catch(null).default(null),
  /** Kept as sent: an unknown one is drawn as itself, never dropped from the list. */
  status: z.string().catch('unknown'),
  shopDomain: z.string().nullable().catch(null).default(null),
  requestedAt: when,
  linkExpiresAt: when,
  installedAt: when,
  /** The app's client id once one is stored. The secret is never sent. */
  clientId: z.string().nullable().catch(null).default(null),
});
export type ConsoleRequest = z.infer<typeof consoleRequestSchema>;

export const consoleRequestsSchema = z.array(consoleRequestSchema);

export interface AppLink {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly installLink: string;
  /** `YYYY-MM-DD` from the date field, or empty: the server's own default. */
  readonly linkExpiresAt: string;
}

/** The body, trimmed; an empty expiry is left out, a date is sent as the day's end in UTC. */
export function appLinkBody(form: AppLink) {
  return {
    clientId: form.clientId.trim(),
    clientSecret: form.clientSecret.trim(),
    installLink: form.installLink.trim(),
    ...expiryOf(form.linkExpiresAt),
  };
}

export function expiryOf(day: string): { linkExpiresAt?: string } {
  const value = day.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? { linkExpiresAt: `${value}T23:59:59.000Z` } : {};
}

export type ConsoleRefusal = 'invalid_link' | 'wrong_state' | 'forbidden' | 'not_found' | 'failed';

export function consoleRefusalOf(status: number | undefined): ConsoleRefusal {
  if (status === 400 || status === 422) return 'invalid_link';
  if (status === 409) return 'wrong_state';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  return 'failed';
}
