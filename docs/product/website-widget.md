# Website widget: one embedded chat (Web chat + Shopify live chat)

Omer, 2026-10-07: "Shopify live chat" and "Web chat" become ONE product, the
**Website widget**. On Install the owner picks the platform: a line of code,
Shopify, or WooCommerce. Design: `redesign/design/Redesigning GOTCHA from scratch 7/GOTCHA Widgets on Store.dc.html`
(our side 13g-13j; serve over http, `file://` breaks its dynamic import).

## What exists (mapped 2026-10-07)

- **One bundle already.** Both run `gotcha-shopify-chat.<hash>.js`;
  `chatcenter-widget.js` (the code snippet) is an adapter that bootstraps
  `/api/embedded-chat` and loads the same bundle.
- **The split** is in: the Channel enum (`WEBCHAT` / `SHOPIFY_LIVE_CHAT`), two
  public APIs (`/api/embedded-chat` vs `/api/shopify-chat`), two settings stores
  (`ChannelAccount.credentials` = `WebchatConfig` vs
  `ChannelAccount.platformMeta.shopifyLiveChat` = `ShopifyLiveChatConfig`), two
  admin APIs (auth `/api/channels/webchat/:id/settings` vs ai
  `/api/shopify-live-chat/channels/:id`), and the v2 screens (Web chat only;
  Shopify live chat has a v1 screen only).
- **Shared settings:** appearance, the whole `ux` block (launcher, hero,
  welcome, proactive, sounds, behaviour), human handoff, offline message.
  **Shopify only:** shop binding, `enabled`, commerce (product messages, add to
  cart, carousel), privacy, hours behaviour, install heartbeat.
- **Install state:** Shopify has `ShopifyChatInstallation` (status, uninstalled,
  heartbeat). Code has only the first visit (PENDING to CONNECTED); no last seen,
  no host.
- **Realtime:** Shopify visitors get socket.io (signed visitor token); the web
  chat falls back to polling every 5 s.
- **Absent:** WhatsApp handoff (no field, no `wa.me`), any WooCommerce storefront
  piece (no plugin, script or cart bridge).
- **Security gaps found while mapping (fix first, small):**
  1. `/api/embedded-chat/message` and `/messages/:sessionId` accept a bare
     conversation id with no visitor token and no channel check: whoever has
     the id reads or writes that web chat conversation.
  2. Web chat settings `GET/PUT /api/channels/webchat/:id/settings` check only
     sign-in, no permission: any member can change the widget.

## Decisions for Omer (before or during A)

1. **"Assigned AI employee (required)" on the widget** (design 13g). Elsewhere
   the playbook decides who answers, and per-employee channels were just found
   inert and slated for removal. Options: (a) the widget's employee is the
   playbook's route for this channel (written to the canvas, one source of
   truth), or (b) drop the field and show who answers from the canvas.
   Recommendation: (a), as a shortcut that edits the playbook, never a second
   routing rule.
2. **One widget per workspace, or per site?** Today: one web chat per tenant,
   one Shopify chat per shop. Recommendation: one widget config per workspace,
   installed on many places (snippet, Shopify shop(s), Woo site(s)).

## Stage A: unified settings and Install (backend ~3.5 days)

Additive; nothing existing breaks (the snippet, `window.__chatcenter`, both
public APIs and the Shopify theme extension keep their names and shapes).

| # | Change | Est. |
|---|---|---|
| 0 | Security: visitor-token check on the web chat message routes; `requirePermission` on web chat settings | 4h |
| 1 | One `WebsiteWidgetSettings` projection: the shared block (appearance, ux, handoff, offline, opening questions, nudge, language) plus a Shopify-only block; pure normalisers with tests. A write updates the shared block on the web chat account AND every Shopify chat account of the workspace, never touching Shopify-only fields (the legacy `welcome` kept in step with `ux.welcome`) | 5h |
| 2 | `GET/PUT /api/website-widget` (services/ai; gateway route): settings, ADMIN/`channels:manage:update`; Shopify-only fields feature-gated | 8h |
| 3 | `GET /api/website-widget/install`: per platform. `code`: snippet + first seen + last seen + host. `shopify`: per shop, connected / uninstalled / app embed live (heartbeat), Theme Editor link; "Install on Shopify" = the existing OAuth install bound to the tenant. `woocommerce`: until C, the snippet | 5h |
| 4 | Web chat heartbeat: throttled last seen + host on `/bootstrap` (existing column, no migration) | 2h |
| 5 | `publicWebchatConfig` turns on product messages / add to cart by source (Shopify yes, code no) | 1h |
| 6 | Fix a lost update: Shopify `recordHeartbeat` rewrites the whole config blob read at bootstrap; write only `install` | 2h |
| 7 | Contract (`docs/api/website-widget-v1.md`), OpenAPI, route tests, live check | 5h |

**Total ~32h (~4 days)** including the security fixes. Frontend builds the one
settings screen + Install on the contract (sent before item 2 lands).

## Stage B: the two customer-side looks (~4 days: backend + bundle)

| # | Change | Est. |
|---|---|---|
| 1 | `look: "gotcha" | "whatsapp"` in settings and the public config | 2h |
| 2 | The bundle: the WhatsApp-style panel ("write here and continue on WhatsApp"); the full GOTCHA panel header with a WhatsApp action | 10h |
| 3 | `whatsappHandoff`: on/off + a number chosen from the workspace's connected WhatsApp numbers; `wa.me/<number>?text=` prefilled with a short reference so the WhatsApp conversation is linked to the widget conversation (the inbound worker matches the reference) | 8h |
| 4 | Web chat visitors on the socket (signed visitor token, the relay extended to WEBCHAT) instead of 5 s polling | 8h |
| 5 | Tests + live check | 4h |

**Total ~32h (~4 days).** Needs from Omer: the handoff's wording and whether a
handed-off conversation continues in the same thread (recommended) or opens a
new one.

**Rides the same auth rebuild (supervisor, 2026-10-07):** the grandfathered
onboarding chat in `services/auth/src/routes/onboarding.ts` still shows model
text with wide dashes. Strip them there (`withoutWideDashes`, as every
operator-facing output in `services/ai` now does since 7706d94f) in the first
auth batch this stage opens. No rebuild of its own.

## Stage C: WooCommerce plugin (a new product; plan)

**What it is:** a WordPress plugin, "GOTCHA for WooCommerce".
- **Connect:** a "Connect to GOTCHA" button in WP admin. Back on GOTCHA the owner
  signs in, the site is bound to the workspace (reusing the existing Woo WC-Auth
  flow for the REST keys) and the plugin receives its widget id (no code to
  paste).
- **Loader:** injects the widget loader with the widget id on the storefront
  (`wp_footer`), respecting the site's cookie / consent plugins.
- **Cart bridge:** add to cart and product data from the widget through the
  WooCommerce Store API (`/wp-json/wc/store/v1/cart/add-item`, nonce from the
  page), so the AI's product cards can add to the real cart; a Woo
  `/cart/validate` on our side like Shopify's.
- **Signals:** activation / deactivation / uninstall hooks tell GOTCHA (the
  install status in Stage A shows "connected" / "removed"); a heartbeat like
  Shopify's.
- **Settings page:** status, "open in GOTCHA", disconnect. All widget settings
  stay in GOTCHA.

**Estimate:** ~6-8 days (PHP plugin 3-4, backend: binding, Woo cart validate,
signals 2, review + packaging + tests on a dev WordPress 1-2). Plus the
distribution's own timeline below.

**Needed from Omer:**
1. **Distribution:** WordPress.org directory (free listing, automatic updates,
   discoverable; requires GPL licensing, a review of typically 1-4 weeks, an
   SVN-published plugin and a WordPress.org account) vs self-hosted zip
   (immediate, but updates need our own update server or manual uploads).
   Recommendation: WordPress.org, with a self-hosted zip for the first
   customers while review runs.
2. Plugin name and slug, short description, icon and banner assets.
3. Privacy policy and support URLs for the listing (Trust Center exists).
4. A WordPress.org account owned by the company (not a person).

## Future (not now)

One channel in the data (`WEBSITE_WIDGET` with a `source` of code / shopify /
woocommerce) instead of two enum values. A data migration touching
conversations, routing, analytics and the inbox filters; worth it only after A
and B settle. Recorded in the plan (§6).
