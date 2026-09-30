import { prisma, shopifyApiVersion } from "@chatcenter/shared";
import { shopifyGraphQLRequest } from "./shopify-graphql";

/**
 * Disconnecting Shopify inside GOTCHA, as a real Shopify uninstall.
 *
 * WHAT WAS WRONG
 * "Disconnect Shopify" cleared GOTCHA's own row and nothing else. The app
 * stayed installed on the store, kept its granted scopes, and kept delivering
 * webhooks. The merchant was told they had disconnected; Shopify had not been
 * told anything.
 *
 * THE OFFICIAL MECHANISM
 * Shopify supports an app uninstalling ITSELF: the `appUninstall` Admin
 * GraphQL mutation, available from API version 2026-07, which this app already
 * targets. It takes no arguments and uninstalls only the calling app, so it is
 * run once per store with that store's offline access token. Shopify performs
 * its own cleanup (webhook subscriptions, admin links) and then delivers a
 * signed `app/uninstalled` webhook.
 *
 * That webhook, not this call, is the authoritative confirmation.
 *
 * WHY THIS DOES NOT DECLARE THE STORE DISCONNECTED
 * A mutation that returns 200 tells us Shopify accepted the request. Treating
 * that as completion would put us back where we started: a local row claiming
 * something about Shopify that Shopify has not confirmed. So this records an
 * intent and leaves the connection authorized until the verified webhook
 * arrives. If it never arrives, the store is still installed and the UI must
 * keep saying so.
 *
 * The intent lives in `config.uninstallRequestedAt` rather than a new
 * `ConnectionStatus` value, because a status enum member would need a
 * migration and the connection genuinely IS still connected until Shopify
 * says otherwise. The pending state is a fact about our request, not about the
 * installation.
 */

export const UNINSTALL_REQUESTED_AT = "uninstallRequestedAt";

export type SelfUninstallOutcome =
  | { ok: true; state: "awaiting_webhook"; shopDomain: string }
  | { ok: false; reason: "not_connected" | "no_token" | "no_shop_domain" | "shopify_refused" };

/** `appUninstall` takes no arguments: it uninstalls whoever is calling. */
const APP_UNINSTALL = `
  mutation GotchaAppUninstall {
    appUninstall {
      app { id }
      userErrors { field message }
    }
  }
`;

/**
 * Ask Shopify to uninstall this app from the tenant's store.
 *
 * Returns `awaiting_webhook` on success. It deliberately does NOT clear
 * credentials, revoke entitlements, drop tool rows or disable the storefront
 * channel: every one of those is the verified webhook's job, and doing them
 * here would strand the merchant with a half-disconnected workspace if Shopify
 * refused the request or the webhook never arrived.
 */
export async function requestShopifySelfUninstall(tenantId: string): Promise<SelfUninstallOutcome> {
  const row = await (prisma as any).tenantIntegration.findFirst({
    where: { tenantId, integration: { slug: "shopify" }, status: { in: ["CONNECTED", "ERROR"] } },
    select: { id: true, config: true, credentials: true },
  });
  if (!row) return { ok: false, reason: "not_connected" };

  const config = (row.config ?? {}) as Record<string, any>;
  const credentials = (row.credentials ?? {}) as Record<string, any>;
  const shopDomain: string = config.shopDomain || credentials.shopDomain || "";
  const token: string = credentials.accessToken || credentials.token || "";
  if (!shopDomain) return { ok: false, reason: "no_shop_domain" };
  if (!token) return { ok: false, reason: "no_token" };

  try {
    await shopifyGraphQLRequest(
      { token, base: `https://${shopDomain}/admin/api/${shopifyApiVersion()}` },
      APP_UNINSTALL,
      {},
      // Never retried. A retried uninstall against an app that is already gone
      // is a 401, which reads as a failure and would make us report the wrong
      // outcome for a request that actually succeeded.
      { retryable: false, userErrorsAt: "appUninstall" },
    );
  } catch (err) {
    console.error(
      `[shopify-uninstall] tenant=${tenantId} shop=${shopDomain} refused: ${(err as Error)?.message}`,
    );
    return { ok: false, reason: "shopify_refused" };
  }

  // Record the intent only. The webhook owns the transition.
  await (prisma as any).tenantIntegration.update({
    where: { id: row.id },
    data: { config: { ...config, [UNINSTALL_REQUESTED_AT]: new Date().toISOString() } },
  });

  return { ok: true, state: "awaiting_webhook", shopDomain };
}

/**
 * Whether we are waiting for Shopify to confirm an uninstall we asked for.
 *
 * Used by every Shopify surface so they agree, and so a merchant who returns
 * without completing is not shown a false "Disconnected".
 */
export function isAwaitingUninstall(config: unknown): boolean {
  return Boolean((config as any)?.[UNINSTALL_REQUESTED_AT]);
}
