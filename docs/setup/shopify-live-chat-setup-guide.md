# Shopify Live Chat

A branded live chat that a Shopify merchant installs on their storefront
with one toggle. It answers product questions with real prices and stock,
sends product cards and carousels, and can add the right variant to the
shopper's cart without ever putting a credential in the browser.

This document is both the merchant setup guide and the engineering
reference. Merchants need §1 to §4. Everything from §5 is for whoever
maintains this.

---

## 1. Two Shopify products, one storefront chat

| Product | What it is | What it owns |
|---|---|---|
| **GOTCHA Shopify Chat App** | A public Shopify App Store app carrying the Theme App Extension | Install, App Embed, storefront widget, visitor sessions, chat, handoff |
| **GOTCHA Core Shopify Integration** | The existing Admin API connection under Settings → Integrations | Products, inventory, orders, customers, refunds, returns, AI commerce tools |

They are **separate Partner apps with separate credentials**. Installing
the Chat app grants no Admin API access at all. Product cards work by
borrowing a safe, server-side projection from the Core integration when
one is connected; when it is not, text chat carries on and product
messaging reports itself as unavailable rather than failing mid-sale.

Full reasoning: `docs/architecture/shopify-core-vs-chat-app.md`.

---

## 2. Merchant setup, start to finish

### 2.1 Install from the Shopify App Store

The merchant clicks **Add app**. Shopify runs authorization and returns
them to GOTCHA's onboarding wizard at `/shopify/chat/install`.

Nothing is copied, pasted or typed in this step. The verified shop domain
comes from the install itself.

### 2.2 Sign in to GOTCHA

The wizard sends them through the normal GOTCHA sign-in. The verified
installation survives the round trip in an HttpOnly continuation session,
so they come back to the same wizard, on the same step.

### 2.3 Choose an organization

Only organizations where they hold `channels:manage:update` are offered.
The organization must be ACTIVE and must hold the `shopify_live_chat`
entitlement - a Shopify install does not bypass plan enforcement.

### 2.4 Connect

One button. GOTCHA:

- binds the verified shop to that organization,
- creates the Shopify Live Chat channel, or reuses the existing one for
  the same store,
- records `<shop>.myshopify.com` as a verified origin, and asks Shopify
  (through the Core connection, when there is one) for the storefront's
  primary domain,
- creates the channel **switched off**.

### 2.5 Activate the App Embed

Shopify keeps app embeds off until a merchant enables them, so this step
cannot be automated. The wizard's button opens the live theme editor with
the GOTCHA Chat embed targeted; the merchant switches it on and saves.

Opening the link proves nothing. The wizard waits for a real page load
from the storefront before it calls the widget active.

### 2.6 Verify

The wizard polls until a storefront heartbeat arrives, then shows the
final state: installed, bound, embed active, chat enabled, product
messaging status and Core integration status.

### Recovery only: the channel key

The `sfy_...` channel key and manual storefront-domain entry still exist,
under **Advanced troubleshooting** in chat settings. They are for support
re-establishing a store whose installation record was lost. A normal
installation never shows them.

## 3. Troubleshooting

The **Status** section runs these checks in order and gives each one a
repair step. The first blocked check is the one to fix.

| What you see | What it means | Fix |
|---|---|---|
| No widget on the storefront, "App Embed not seen" | The embed is off in this theme | Turn on the GOTCHA Chat app embed and save |
| No widget on your custom domain, but it works on `.myshopify.com` | The custom domain was not verified at install time (usually: no Core connection to ask) | Connect Shopify under Settings → Integrations, or add the domain under Advanced troubleshooting |
| "Channel bound to a different store" | The workspace reconnected Shopify to another store | Reconnect the original store, or delete this channel and create one for the new store |
| Chat works, no product cards | Missing `read_products` scope, or the product messaging entitlement | Reconnect Shopify to grant the scope; contact your administrator for the entitlement |
| "No routing target" | No AI employee or department assigned | Assign one under AI employee or Routing |
| Widget disappeared after a theme change | App embeds are per theme | Re-enable the embed on the new theme |

Raw Shopify errors are never shown to a merchant. If a check says
something vague, the detail is in the service logs under
`[shopify-chat]` or `[shopify-live-chat]`.

### Uninstall behaviour

- **Disable the channel** → the storefront stops bootstrapping
  immediately. Conversation history is kept.
- **Turn off the app embed** → the widget stops loading. The channel
  stays configured and starts working again when re-enabled.
- **Delete the channel** → disabled first, then removed. Conversations
  on the channel are removed with it. Warned about before it happens.
- **Uninstall the CHAT app in Shopify** → `app/uninstalled` retires the
  installation and switches the channel off. The storefront stops
  bootstrapping. The Core commerce integration is untouched.
- **Uninstall the CORE app in Shopify** → the commerce connection is
  marked DISCONNECTED and its credentials dropped. Text chat keeps
  working; product cards and Add to Cart report themselves unavailable.
- **Reinstall the Chat app** → the previous organization and channel are
  restored, but only after Shopify re-proves the merchant controls the
  store.

---

## 4. What the widget does and does not collect

Shoppers are **anonymous by default**. The widget stores one opaque
first-party value in `localStorage` and nothing else. No cookies are set,
so nothing here is affected by third-party cookie blocking.

**Read from the storefront:** page type, product handle, collection
handle, path (query string stripped), cart item **count**, currency,
locale, theme id.

**Never read:** cart contents, cart value, prices, stock levels, the
logged-in Shopify customer id, or anything about who the shopper is.

The page context is a **hint**, not a fact. A product handle is used as a
lookup key and the product is re-read from Shopify before the assistant
says anything about it.

Cart contents can be enabled per channel under **Privacy**, off by
default, and even then only the item count is read.

Order lookups and account-specific actions still require GOTCHA's normal
customer verification. A shopper saying "yes, that is me" is not
verification.

---

## 5. Architecture

### 5.1 What was reused

Everything. The channel is `ChannelType.SHOPIFY_LIVE_CHAT` and rides on
the existing platform:

| Piece | Reused from |
|---|---|
| Channel record | `ChannelAccount` (public key in `external_id`, config in `platform_meta`) |
| Conversations, messages, inbox | `Conversation` / `Message`, unchanged |
| Inbound pipeline | `incomingMessageQueue` → incoming-worker → routing → AI employee |
| Realtime | The conversation service's existing socket.io server |
| AI | The same AI employee, prompt builder and tool dispatcher |
| Products | The existing Shopify integration and its adapter |
| Entitlements | `FEATURES` + `TenantFeature` |
| Analytics | `analyticsQueue` |
| Audit | `AuditLog` |

The migration is **one additive enum value**. No new tables, no second
inbox, no product mirror, no parallel AI engine.

### 5.2 Files

```
packages/shared/src/lib/shopify-live-chat.ts     domain rules, config, sessions, snapshots
packages/shared/src/channels/shopify-live-chat.adapter.ts   outbound adapter (no-op by design)
services/ai/src/routes/shopify-chat-public.ts    PUBLIC storefront API
services/ai/src/routes/shopify-live-chat.ts      merchant admin API + agent product picker
services/ai/src/services/shopify-catalog.service.ts     product truth + cart validation
services/ai/src/services/shopify-live-chat.service.ts   channel lifecycle + bootstrap gate
services/ai/src/services/shopify-chat-turn.service.ts   per-turn AI wiring
services/ai/src/services/shopify-commerce-message.service.ts   structured message shape
services/conversation/src/subscribers/shopify-visitor-relay.ts  realtime projection
frontend/public/widget/gotcha-shopify-bootstrap.js      launcher (4.4 KB gz)
frontend/public/widget/gotcha-shopify-chat.js           chat app (14.8 KB gz, lazy)
shopify-app/extensions/gotcha-chat/                     Theme App Extension
```

### 5.3 Storefront installation

A **Theme App Extension** with an App Embed block. The block:

- publishes the page context only Liquid can know
- declares the public channel key
- loads the bootstrap `async`

It renders no markup into the theme's layout. The widget mounts itself
into a Shadow DOM host it creates, so no theme CSS can reach in and none
of ours can leak out.

**Measured** (Chromium, desktop, local harness):

| | Raw | Gzipped |
|---|---|---|
| Bootstrap (every page) | 11.9 KB | **4.4 KB** |
| Chat app (after interaction) | 57.2 KB | 16.5 KB |
| socket.io client (with chat app) | 46.8 KB | 14.7 KB |

| | |
|---|---|
| Widget requests on page load | **2** (bootstrap script + `POST /bootstrap`) |
| Launcher visible after | ~0.6 s from navigation start |
| Widget open (click to panel painted) | **40 ms** |
| Carousel of 3 cards, repaint | < 1 ms |

The chat app and socket.io load only when a shopper opens the widget, or
during idle time for a returning shopper who already has a conversation
open. A visitor who never opens the widget downloads 4.4 KB and makes one
API call. Product images are lazy and restricted to Shopify's CDN.

---

## 6. Security model

### 6.1 Public surface

`/api/shopify-chat/*` is unauthenticated by design. The trust model is:

```
public channel key  +  verified request Origin  +  signed visitor session
```

Checks run in this order on every bootstrap: channel exists → channel
enabled → store bound → **Origin allowlisted** → tenant active →
entitlement.

Every refusal returns the same body:

```json
{ "error": "unavailable" }
```

A disabled channel, a lapsed plan, a disconnected store and an unknown
key are indistinguishable from the storefront. A storefront is not a
debugging surface and must not leak billing state.

**Origin matching is exact.** No suffix matching, no wildcards:
`evil-myshop.com` does not satisfy `myshop.com`.

nginx does **not** add CORS headers on this path. The allowed origin
differs per channel and only the service knows which one is legal; the
service echoes the request Origin only after checking it.

### 6.2 Visitor sessions

AES-256-GCM over a compact payload, `iv || tag || ciphertext`, base64url.

**Encrypted, not merely signed.** A signed-but-readable token would hand
every shopper the internal tenant and channel ids for the price of a
base64 decode. GCM is authenticated, so it is tamper-evident without a
second HMAC.

Deliberately **not JWT-shaped**: no middleware anywhere in the platform
should be able to mistake one for a staff token. It carries no user
identity.

Key: `WIDGET_SESSION_SECRET`, falling back to `JWT_SECRET`. Required in
production; the module refuses to issue sessions with a default secret.
Deliberately **not** the channel-credential key: different rotation
lifetimes.

A session is re-checked against live channel state on every call, so
disabling the widget or losing the entitlement takes effect immediately
for sessions already in flight.

### 6.3 Product and cart safety

Nothing about money, stock, identity or store membership is accepted
from a browser.

Before any cart action the server re-resolves the product from Shopify
and checks, in order:

1. the connected store still matches the channel's bound store
2. the product exists
3. the variant **belongs to that product** (membership, not existence:
   this is what stops a valid-looking id from another product being
   smuggled in)
4. it is not selling-plan-only
5. it is in stock
6. the quantity is a whole number between 1 and 10

Only then does the browser receive a variant id, which the widget posts
to the **theme's own** `/cart/add.js`, same-origin. No Admin credential
is involved. **No order is ever created from chat.**

Product imagery is restricted to Shopify's CDN. An attacker-controlled
image host inside a merchant's storefront is a tracking pixel with a view
of every conversation.

### 6.4 Cross-tenant and cross-store isolation

- Every query is tenant-scoped; `packages/shared/src/lib/prisma.ts`
  refuses a bulk query without a tenant filter.
- A commerce payload records the shop domain **and** the channel account
  id, and both are re-checked at render time on the widget and in the
  inbox.
- A visitor socket joins exactly one room, `visitor:<conversationId>`,
  and never a tenant-wide room.
- Merchant config writes are normalised on the way in: hex colours only,
  a named launcher glyph, a clamped radius, https-only assets, markup and
  control characters stripped. There is no path from merchant text to
  storefront markup.
- The widget builds DOM from element factories and never interpolates
  HTML, so message and product content cannot become markup.

### 6.5 Rate limits

Per `(key, ip)`, overridable by env:

| Route | Default / min | Env |
|---|---|---|
| `/bootstrap` | 20 | `SHOPIFY_CHAT_BOOTSTRAP_RPM` |
| `/conversation`, `/handoff`, `/lead` | 20 | `SHOPIFY_CHAT_CONVERSATION_RPM` |
| `/message` | 20 | `SHOPIFY_CHAT_MESSAGE_RPM` |
| `/messages` | 60 | `SHOPIFY_CHAT_POLL_RPM` |
| `/cart/validate`, `/cart/result` | 30 | `SHOPIFY_CHAT_CART_RPM` |
| `/events` | 60 | `SHOPIFY_CHAT_EVENTS_RPM` |

Message bodies are capped at 2000 characters after normalisation;
anything over 8000 is refused outright without being processed.

---

## 7. AI product behaviour

The assigned AI employee gets two extra tools on Shopify Live Chat
conversations where product messaging is allowed:

- `send_product_card` - one product
- `send_product_carousel` - up to five, default three

They are separate tools on purpose. "Here is the one I recommend" and
"here are a few to compare" are different answers; folding them into a
count parameter reliably produced one-item carousels.

**Both accept references only.** The server re-reads title, price, image
and stock from Shopify. An invented product id resolves to nothing and
the model is told so. That is the mechanism behind "the AI cannot invent
a product" - not a prompt instruction.

Cards are **staged**, not written. The bot's text reply is persisted
first by the incoming worker, then the cards. A card that arrives before
its own reasoning reads like an ad. Staged cards are dropped entirely on
escalation or an approval pause.

The AI also receives a `## Shopify Storefront` context block describing
the page the shopper's last message came from, including the
**server-resolved** product for a product page. So "is this good for long
runs?" is answered about the right product, at the right price.

---

## 8. Human agents

The inbox composer grows a **Products** button on Shopify Live Chat
conversations only. On any other channel there is nowhere to render a
card, and offering the button would promise something the customer would
never receive.

The picker shows the same card the shopper will receive, with live price
and stock. Selecting several sends a carousel. Everything is re-resolved
server-side against the conversation's own store before persisting.

Conversations appear in the existing inbox with a Shopify badge, the
store name, and a context strip showing where the shopper is standing.
AI-first, human takeover, department routing, notes and tags all work
exactly as they do on every other channel.

---

## 9. Configuration reference

Stored under `ChannelAccount.platformMeta.shopifyLiveChat`, always
normalised on write.

| Group | Fields |
|---|---|
| binding | `shopDomain`, `tenantIntegrationId` (set once at creation, not patchable) |
| appearance | `primaryColor`, `contrastColor`, `logoUrl`, `avatarUrl`, `launcherIcon`, `launcherPosition`, `cornerRadius` (0-28), `language`, `direction`, `showPoweredBy` |
| welcome | `headline`, `subline`, `assistantName`, `suggestedQuestions` (max 5) |
| hours | `enabled`, `timezone`, `week`, `offlineBehavior`, `offlineMessage`, `offlineFormFields`, `offlineConsentText` |
| routing | `aiAgentId`, `departmentId`, `allowHumanHandoff`, `allowReturnToAi` |
| commerce | `productMessagingEnabled`, `carouselSize` (1-5), `addToCartEnabled`, `allowUnpublishedProducts` |
| privacy | `useCartContext`, `requireOfflineConsent` |
| install | `storefrontDomains`, `lastHeartbeatAt`, `lastThemeId`, `lastSeenPath` |

### Environment

| Variable | Purpose |
|---|---|
| `WIDGET_SESSION_SECRET` | Visitor session key. Falls back to `JWT_SECRET`. Required in production. |
| `SHOPIFY_APP_CLIENT_ID` | Builds the Theme Editor deep link. Without it, written instructions are shown instead. |
| `SHOPIFY_CHAT_BLOCK_HANDLE` | App embed handle. Default `gotcha-chat`. |

---

## 10. Verifying against a development store

Use a Shopify **development store**. Never a real merchant's store
without written approval, and never with real customer data.

1. Connect the development store under Settings → Integrations.
2. Create the channel, assign an AI employee, add the storefront domain.
3. Activate the app embed and paste the channel key.
4. Enable the channel.
5. Open the storefront and confirm the launcher appears.
6. Open the chat: the welcome state should carry the store's branding.
7. Send a suggested question and free text; both start one conversation.
8. Refresh: the conversation resumes rather than restarting.
9. From a product page ask "is this good for X?" and confirm the answer
   is about that product at its real price.
10. Confirm a product card and a carousel render with real products.
11. Select a variant and add to cart; confirm the correct variant lands
    in the Shopify cart and the theme's cart count updates.
12. Confirm the conversation is in the GOTCHA inbox with the Shopify
    badge and page context.
13. Send a product from the agent picker.
14. Request a human and confirm the handoff.
15. Disable the channel and confirm the widget stops loading.
16. Repeat on a phone, and in Hebrew.
