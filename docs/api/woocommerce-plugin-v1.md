# GOTCHA for WooCommerce: the plugin ↔ backend contract (v1, manual install)

Status: CONTRACT (2026-10-08). Stage C of docs/product/website-widget.md, manual
path first (Omer's decision): a zip downloaded from GOTCHA's Install screen,
uploaded in WP Admin, then "Connect to GOTCHA" through the existing WooCommerce
key flow. The WordPress.org submission runs in parallel and does not change
this contract.

## 1. What the plugin does (C1: this contract)

- **Connect:** a settings page in WP Admin (WooCommerce → GOTCHA) with a
  "Connect to GOTCHA" button. It opens GOTCHA in the browser (§2); back in WP
  Admin the plugin exchanges a one-time code for its widget id and site key.
- **Loader:** on every storefront page (`wp_footer`), the widget loader with the
  workspace's widget id, the same one the code snippet uses, plus
  `platform: "woocommerce"`. Not on admin, login or checkout-payment pages.
  When a cookie / consent plugin blocks "functional" scripts, the loader waits
  for consent (WP Consent API when present).
- **Signals:** activation, deactivation, uninstall and a daily heartbeat
  (WP-Cron) tell GOTCHA; GOTCHA's Install screen shows the site as connected /
  deactivated / removed and when it was last seen.
- **Settings page:** status, "Open in GOTCHA", "Disconnect". Every widget
  setting stays in GOTCHA.

Not in C1: the cart bridge (the AI's product cards adding to the real Woo cart
through the Store API) is C2, with its own contract.

## 2. Connect

1. The plugin stores a random `nonce` (transient, 15 minutes) and opens
   `{app}/v2/connect/woocommerce?site=<home_url>&return=<settings page url>&nonce=<nonce>`.
   The key flow (step 2) comes back to the same page with `?connected=1` or
   `?error=<code>`; the page keeps `site` / `return` / `nonce` itself (e.g.
   sessionStorage) across that round-trip.
2. On GOTCHA (frontend page): the owner signs in and picks the workspace. If
   the workspace has no WooCommerce connection for this store, the page runs
   the existing key flow first (`GET /api/integrations/woocommerce/oauth/init?
   storeUrl=<site>&flow=wp_plugin&format=json`), which comes back to the page.
3. The page calls `POST /api/woocommerce-plugin/bind` (authenticated,
   permission `integrations:connections:connect`) with `{ siteUrl, returnUrl, nonce }`.
   - `siteUrl` must be the store the workspace is connected to (same host as the
     WooCommerce connection's storeUrl): else `409 { code: "STORE_NOT_CONNECTED" }`.
   - `returnUrl` must be on the same host as `siteUrl` and under `/wp-admin/`:
     else `422 { code: "BAD_RETURN_URL" }`.
   - `200 { redirect: "<returnUrl>&gotcha_code=<code>&nonce=<nonce>" }`: a
     single-use code, 10 minutes, bound to tenant + siteUrl + nonce.
4. Back in WP Admin, the plugin checks `nonce` against its own, then
   server-to-server: `POST /api/woocommerce-plugin/exchange { code, siteUrl }`
   (unauthenticated; the code is the credential).
   - `200 { widgetId, siteKey, apiUrl, scriptUrl, workspaceName }`. `siteKey`
     is a secret for signals (stored hashed by GOTCHA, shown once).
   - `410 { code: "CODE_EXPIRED" }` used or expired; `409 { code: "SITE_MISMATCH" }`.
   - `409 { code: "WIDGET_NOT_CREATED" }` when the workspace has no web chat
     yet (the bind page creates it first, so this is a race).

## 3. Signals

`POST /api/woocommerce-plugin/signal` with header `Authorization: Bearer <siteKey>`
and `{ event: "activated" | "deactivated" | "uninstalled" | "heartbeat",
pluginVersion, wpVersion, wcVersion, siteUrl }`. `204`; `401` for an unknown
key (the plugin then shows "Not connected"). An `uninstalled` site key is
revoked. At most one heartbeat a day is recorded.

## 4. Disconnect

From WP Admin: the plugin sends `uninstalled`-like `event: "disconnected"`
(same endpoint) and forgets its key. From GOTCHA: `DELETE
/api/woocommerce-plugin/sites/:id` (permission `integrations:connections:disconnect`)
revokes the key; the plugin's next signal gets `401` and shows "Not connected".

## 5. Where GOTCHA keeps it

A durable tenant setting `woocommerce_plugin_sites` (no migration):
`[{ id, siteUrl, keyHash, status: "connected" | "deactivated" | "removed",
connectedAt, lastSeenAt, pluginVersion, wpVersion, wcVersion }]`. A site key
maps to its tenant through a Redis index `wcplugin:key:<sha256>` → tenantId
(rebuilt from the setting when missing).

`GET /api/website-widget/install`: its `woocommerce` object keeps `status`
(`"use_code"` until a site is connected through the plugin, then `"plugin"`)
and gains `sites: [{ id, siteUrl, status, lastSeenAt, pluginVersion }]` and
`downloadUrl` (the zip, §6).

## 6. The zip

`GET /api/woocommerce-plugin/download` (authenticated): the current plugin as
`gotcha-for-woocommerce.zip`. The plugin source lives in the repository
(`services/ai/src/assets/woocommerce-plugin/gotcha-for-woocommerce/`, so it
ships with the ai image), GPL-2.0-or-later (a WordPress requirement). Bind,
download: permission `integrations:connections:connect`; removing a site:
`integrations:connections:disconnect` (the same as connecting / disconnecting
a business system).

## 7. Needed from Omer (for the zip now and the WordPress.org listing later)

1. Plugin name and slug. Proposal: "GOTCHA for WooCommerce", slug
   `gotcha-for-woocommerce`.
2. Short description (at most 150 characters) and a longer one (he/en).
3. Icon PNG 256×256 and 128×128; banner PNG 1544×500 and 772×250;
   2-4 screenshots (WordPress.org only).
4. URLs: privacy policy (Trust Center), terms, support; plugin homepage.
5. The author name as it should appear (the company's name), and agreement
   to license the plugin code GPL-2.0-or-later (WordPress.org requires it).
6. A WordPress.org account owned by the company, for the parallel submission.
7. Minimum versions. Proposal: WordPress 6.4, WooCommerce 8.0, PHP 7.4.
8. Testing: installing the plugin on the dev WordPress store
   (`~/services/woo-dev`, demo-store.28042000.xyz) needs his word.
