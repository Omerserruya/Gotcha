# GOTCHA Core Shopify Integration vs GOTCHA Shopify Chat App

**Date:** 2026-07-28
**Status:** Audit + architectural decision. No code changed by this document.
**Scope:** Shopify app identity, OAuth, scopes, entitlements, storefront
runtime, lifecycle and data ownership.

Two products are described here. They are never referred to jointly as
"the Shopify integration".

| Term | Means |
|---|---|
| **GOTCHA Core Shopify Integration** | The back-office Admin API connection: OAuth, products, inventory, orders, customers, refunds, returns, discounts, AI tool surface, agent order context, store-to-tenant binding. |
| **GOTCHA Shopify Chat App** | The storefront experience: Theme App Extension, App Embed, widget bootstrap, visitor session, product cards, variant selection, Add to Cart, chat messages, handoff. |

---

## 1. Audit — GOTCHA Core Shopify Integration (as built)

| Property | Current state | Evidence |
|---|---|---|
| App identity | `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` | `services/ai/src/routes/connectors-admin.ts:472`, `docker-compose.yml:429` |
| OAuth init | `GET /api/connectors/shopify/oauth/init?shop=` — authenticated, tenant-scoped, `canConnectSystems` | `connectors-admin.ts:468` |
| OAuth callback | `GET /api/connectors/shopify/oauth/callback` | `connectors-admin.ts:515`, nginx `location /api/connectors` (`nginx/nginx.conf.template:693`) |
| Redirect URI (real) | dev `https://dev.gotcha.co.il/api/connectors/shopify/oauth/callback`; prod `https://app.gotcha.co.il/api/connectors/shopify/oauth/callback` | `.env:172`, `.env.prod:160` |
| Scopes requested | `read_orders, write_orders, read_customers, read_price_rules, write_price_rules, write_discounts, read_products, read_returns` | `connectors-admin.ts:497-504` |
| Scopes used but **not** requested | `write_customers` (tags, notes, customer updates) — every customer write 403s | `shopify.adapter.ts:293-297`, `docs/integrations/shopify-tool-audit-2026-07-20.md` §6 |
| Token type | Expiring offline token (`expiring: "1"`) + refresh grant; legacy non-expiring tokens migrate via token exchange | `connectors-admin.ts:532-539`, `shopify.adapter.ts` header |
| Token storage | `TenantIntegration.credentials`, AES encrypted via `encryptCredentials`; `config.shopDomain` holds the binding | `connectors-admin.ts:544-556` |
| Load path | `loadConnection({tenantId, slug:"shopify"})` — accepts `CONNECTED` and `ERROR` (recoverable), excludes `DISCONNECTED` | `integration-framework.ts:122-161` |
| Webhooks | **None. No Shopify webhook handler exists in any service.** No `app/uninstalled`, no order/product webhooks | grep across `services/` returns nothing |
| Distribution | Shopify Partner app (Protected Customer Data approval governs `read_customers`/`read_orders`; `write_customers` awaiting merchant approval) | tool audit §6, `project_shopify_protected_customer_data_403` |
| Installed base (dev) | **1** store: `urban-supply-gotcha-demo.myshopify.com`, status `CONNECTED` | `tenant_integrations` query, 2026-07-28 |
| Installed base (prod) | **Unknown from here** — production DB not reachable from this environment. Must be confirmed before any app-config change. | — |
| Production dependencies | AI tool dispatch (`executeAdapterTool`), CRM source-of-truth projection (`config.useAsCrm`), commerce context panel, discovery/product path, **and the Chat App's product truth** | `shopify.adapter.ts`, `crm-adapter.impl.ts`, `commerce-context.service.ts`, `shopify-catalog.service.ts` |

### Verdict

The Core Integration is a working, production-grade Admin API connector with
one structural gap: **no webhook surface at all**, so an uninstall on Shopify's
side is invisible to GOTCHA. It keeps working with Chat absent — nothing in the
core path reads chat state.

---

## 2. Audit — GOTCHA Shopify Chat App (as built)

| Property | Current state | Evidence |
|---|---|---|
| App manifest | `shopify-app/shopify.app.toml` — **a separate app**: `name = "GOTCHA Chat"`, `handle = "gotcha-chat"`, `embedded = false`, `scopes = "read_products"` | file |
| Theme App Extension | `shopify-app/extensions/gotcha-chat/`, App Embed block `gotcha_chat.liquid`, `target: body` | file |
| App Embed inputs | `channel_key` (public), `open_on_load`, `api_base`, `asset_base` — pasted by the merchant | `gotcha_chat.liquid` schema |
| Storefront trust model | public channel key + verified `Origin` + AES-256-GCM **encrypted** visitor session. Browser never names a tenant | `shopify-chat-public.ts:1-18`, `resolveForBootstrap` |
| What the browser receives | appearance, welcome copy, offline config, three feature booleans. **No** Admin token, **no** tenant id, **no** integration id, **no** AI configuration | `publicWidgetConfig`, `shopify-chat-public.ts:220-260` |
| Product truth | server-side only, via the **Core Integration's** connection (`executeAdapterTool` → `loadConnection(slug:"shopify")`) | `shopify-catalog.service.ts:56-70` |
| Add to Cart | validated server-side (`validateCartLine`: quantity, store match, variant membership, publish state), then executed **by the shopper's own browser** against the theme's `/cart/add.js` | `shopify-catalog.service.ts:298+` |
| Activation state | storefront heartbeat (`recordHeartbeat`) → `install.lastHeartbeatAt`, 7-day freshness window | `shopify-chat-public.ts:180-186`, `shopify-live-chat.ts:275-278` |
| Entitlements | `shopify_live_chat`, `shopify_product_messaging` (runtime `FEATURE_METADATA` flags) | `packages/shared/src/lib/features.ts:205-215` |
| Sellable catalog | **Absent.** `feature-catalog.ts` has no Shopify key at all, so neither product can be attached to a plan today | `packages/shared/src/lib/billing/feature-catalog.ts` |

### Verdict

The storefront runtime is already correctly isolated: it holds no credential,
needs no write scope, and re-resolves every commercial fact server-side. Its
only Admin dependency is `read_products`, which it currently borrows from the
Core Integration.

---

## 3. Findings that constrain the decision

**F1 — The repo already contains a second app manifest, and it is wired
wrong.** `shopify-app/shopify.app.toml` declares redirect
`https://api.gotcha.co.il/api/integrations/shopify/callback`. The real callback
is `https://<host>/api/connectors/shopify/oauth/callback`. Host and path are
both wrong.

**F2 — CRITICAL, production risk.** That manifest sets
`include_config_on_deploy = true` and `scopes = "read_products"`. If it is ever
deployed (`shopify app deploy`) against the **Core** app's client id, it
overwrites the core app's scope list and redirect allowlist. Every connected
store loses `read_orders / write_orders / read_customers / price rules /
returns` and OAuth breaks on a redirect URI that does not exist. **Do not run
`shopify app deploy` from this repo until §8 step 1 is done.**

**F3 — Two app identities already exist in code, one of them unset.** The core
uses `SHOPIFY_API_KEY`; the Theme Editor deep link uses `SHOPIFY_APP_CLIENT_ID`
(`shopify-live-chat.ts:48`). `SHOPIFY_APP_CLIENT_ID` and
`SHOPIFY_CHAT_BLOCK_HANDLE` appear in **neither** `docker-compose.yml` nor
`docker-compose.prod.yml` → `themeEditorDeepLink` is `null` in every
environment and merchants never get the one-click activation link.

**F4 — No uninstall path.** Nothing handles `app/uninstalled`. A merchant who
removes the app in Shopify leaves `TenantIntegration.status = CONNECTED` with a
dead token, and the chat channel keeps serving text chat indefinitely.

**F5 — Scope asymmetry.** Chat needs `read_products`. Core requests seven
scopes including `write_orders` and `write_discounts`. Riding one app means a
merchant who wants only a storefront chat grants refund and discount authority.

**F6 — Chat currently has a hard runtime dependency on Core.** No core
connection → no product cards, no Add to Cart validation. Text chat continues
(`resolveForBootstrap` never checks the integration).

**F7 — Nothing is sellable.** Both Shopify capabilities live only as runtime
flags. Until they exist in `feature-catalog.ts` they cannot be attached to a
plan, priced, or shown on a pricing page.

---

## 4. Option comparison

| Criterion | Option 1 — Theme extension inside the Core app | Option 2 — Separate Chat app |
|---|---|---|
| Merchant experience | One install; chat appears as an embed to activate | Two installs; chat is its own listing with its own value story |
| One install vs two | 1 | 2 (second one is scope-light: install → activate embed → paste key) |
| Scope separation | None at the Shopify layer — chat inherits the merchant's full grant | Real: chat app can hold `read_products` and nothing else |
| Security isolation | Policy-level only (GOTCHA code must never reach a write tool from a storefront path) | Structural: no write scope exists on the app, so a code defect cannot escalate |
| App Store review | Chat is reviewed together with a PCD-scoped commerce app; chat cannot ship until the core's PCD review clears | Chat listable on `read_products` alone, independent of the core's PCD status |
| Theme App Extension ownership | Core app owns it; extension version ships with core releases | Chat app owns it; theme releases decoupled from connector releases |
| Existing connected stores | Adding an extension does **not** change scopes → no reauthorization | Untouched; core client id, scopes and tokens unchanged |
| Independent release cycles | Coupled | Independent |
| Independent uninstall | Impossible — uninstalling core removes the extension and kills the widget | Uninstall chat → widget stops, commerce untouched. Uninstall core → cards degrade, chat lives |
| Sell Chat separately | Possible in GOTCHA billing, but not as a Shopify listing | Yes, both in GOTCHA billing and as a standalone listing |
| Entitlement control | Same (GOTCHA-side, unaffected by app topology) | Same |
| OAuth complexity | None added | One more OAuth + one more uninstall webhook + duplicate-install guard |
| Production risk | Low today, but any manifest deploy mistake hits the live connector (F2) | Manifest changes for chat can never touch the connector's config |
| Backward compatibility | Full | Full — there is no chat installed base to migrate |
| Development-store testing | One dev store install covers both | Two installs on the dev store; each testable in isolation |
| Maintenance cost | Lower: one manifest, one token, one webhook surface | Higher: two manifests, two tokens, two uninstall handlers, a binding table |

---

## 5. Required separation matrix

Legend: ✅ owns / performs · ➖ not involved · ⚠️ involved only via a safe projection.

| Capability | Core Integration | Chat App | Shared backend service | Shopify browser / storefront | Required Shopify scope | Required GOTCHA entitlement |
|---|---|---|---|---|---|---|
| Store connection (shop → tenant) | ✅ owns the binding (`TenantIntegration.config.shopDomain`) | ⚠️ binds via the pasted public channel key, never by tenant id | resolves both | ➖ | — | `shopify_core_integration` |
| OAuth | ✅ full Admin OAuth, expiring offline token | ✅ own install, minimal scope (see §7) | stores + rotates both tokens separately | ➖ | core: 7 scopes; chat: `read_products` | `shopify_core_integration` / `shopify_live_chat` |
| Products | ✅ tool surface (`get_product`, `search_products`) | ⚠️ read-only projection only | `buildProductSnapshot` — safe projection | ⚠️ receives snapshot fields only | `read_products` | `shopify_core_integration` / `shopify_product_messaging` |
| Inventory | ✅ `inventory_status`, `variant_information` | ⚠️ `available` boolean inside a card | derives availability | ⚠️ boolean only, never raw counts | `read_products` | as above |
| Orders | ✅ read + write (`get_order`, `cancel_order`) | ➖ **never** | agent/AI paths only | ➖ | `read_orders`, `write_orders` | `shopify_order_actions` |
| Customers | ✅ lookup, tags, notes, CRM projection | ➖ **never** | agent/AI paths only | ➖ | `read_customers`, `write_customers` | `shopify_order_actions` |
| Refunds | ✅ `process_refund` (HITL-gated) | ➖ **never** | approval state machine | ➖ | `write_orders` | `shopify_order_actions` |
| Returns | ✅ `get_returns` (GraphQL) | ➖ **never** | agent/AI paths only | ➖ | `read_returns` | `shopify_order_actions` |
| Theme App Extension | ➖ | ✅ owns the extension | ➖ | ✅ renders the embed | none | `shopify_live_chat` |
| App Embed activation | ➖ | ✅ merchant activates in Theme Editor | records heartbeat as observed fact | ✅ emits heartbeat on load | none | `shopify_live_chat` |
| Chat bootstrap | ➖ | ✅ | `resolveForBootstrap`: key → origin → tenant status → entitlement | ⚠️ receives appearance + 3 feature booleans | none | `shopify_live_chat` |
| Product cards / carousel | ⚠️ supplies the underlying read | ✅ presents | snapshot + entitlement check | ⚠️ snapshot only | `read_products` | `shopify_product_messaging` |
| Add to Cart | ➖ | ✅ offers | `validateCartLine` (store match, variant membership, publish state) | ✅ **executes** via the theme's own `/cart/add.js` | `read_products` (validation only) | `shopify_product_messaging` |
| Visitor identity | ➖ | ✅ owns | mints AES-256-GCM session; `visitorId` = `Conversation.customerExternalId` | ⚠️ holds an opaque token it cannot read | none | `shopify_live_chat` |
| Human handoff | ➖ | ✅ requests | conversation/routing services | ⚠️ sees only a state change | none | `shopify_live_chat` |
| Uninstall | ✅ must mark the connection `DISCONNECTED` | ✅ must disable the channel | two distinct webhook handlers (**neither exists today**) | ➖ | none | — |
| Webhooks | ✅ `app/uninstalled` (+ future order/product topics) | ✅ `app/uninstalled` only | HMAC-verified per app secret | ➖ | none | — |
| Billing | ➖ GOTCHA-side subscription | ➖ GOTCHA-side subscription | `services/billing` | ➖ | none | — |
| Entitlements | ✅ gates connect + tool dispatch | ✅ gates bootstrap + cards | `TenantFeature` read cache | ➖ | none | all four keys |

---

## 6. Independent lifecycle states

| # | State | Continues working | Stops |
|---|---|---|---|
| 1 | Core connected, Chat disabled | Every AI/agent commerce capability: products, orders, customers, refunds, returns, CRM projection, commerce context panel | Storefront widget refuses bootstrap (`denial: disabled`). No shopper-facing surface |
| 2 | Core connected, Chat enabled | Everything: text chat, product cards, carousel, Add to Cart, handoff, plus all core capabilities | — |
| 3 | Chat installed, App Embed **not** activated in Theme Editor | Everything server-side; diagnostics report `app_embed: blocked` ("never reported from the storefront") | No widget on the storefront — the embed is what loads it. Correctly reported, not silently "live" |
| 4 | Chat enabled, Core **disconnected** | Text chat, welcome, suggested questions, business hours, offline form, human handoff. Bootstrap does **not** check the integration | Product cards, carousel, Add to Cart validation (`requireStore` → `unavailable`). **Today the widget still advertises `productMessaging: true`** — see §8 step 6 |
| 5 | Core uninstalled in Shopify | Nothing detects it today (F4): GOTCHA still shows `CONNECTED`, every Admin call fails at runtime | Should: connection → `DISCONNECTED`, tools withdrawn, chat degrades to state 4 |
| 6 | Chat App uninstalled (Option 2) | All core commerce capability, untouched | Theme extension disappears → widget stops. Channel should auto-disable and stop claiming "live" |
| 7 | Shopify entitlement removed | Depends which key: removing `shopify_product_messaging` leaves a working text chat; removing `shopify_live_chat` stops the widget only | The removed capability, at the server, on the next request — not just hidden in the UI |
| 8 | Tenant plan expired / tenant not ACTIVE | Nothing on the storefront: `resolveForBootstrap` refuses on `tenant_inactive` before entitlement is even read | Widget, cards, cart validation. Merchant-side admin follows the platform's standing/plan gate |
| 9 | Store changes theme | Channel, key, config, conversations — all unaffected | The App Embed, until re-activated on the new theme. Heartbeat goes stale → `app_embed: blocked` within the 7-day window. **A fresher signal is warranted (§8 step 7)** |
| 10 | Merchant reconnects the store | Same shop → everything resumes; capability probe re-runs; AI tool grants reconcile | Different shop → `store_binding` check blocks the channel ("created for a different store"); cart validation refuses on `store_mismatch`. Correct and already enforced |

---

## 7. OAuth and scope separation

### Does the Chat App need OAuth?

A Theme App Extension can only be activated for an app the merchant has
**installed**, and a public Shopify app install completes OAuth. So yes — but
the grant can be trivial. The chat runtime never authenticates by token: it
resolves the tenant from the **pasted public channel key** plus the verified
request `Origin`.

**If the extension stays in the Core app (Option 1):**
- Reused scopes: `read_products` only, out of the seven the merchant already granted.
- **No reauthorization** — adding a theme extension does not change the scope list. Existing connected stores are unaffected.
- Chat can be disabled independently: it is a GOTCHA-side entitlement plus the channel's own `enabled` flag plus the App Embed toggle. Three independent off-switches, none of which touch the connector.
- Uninstalling the core app **necessarily removes Chat** — the extension belongs to that app. No independent chat lifecycle is possible.

**If the Chat App is separate (Option 2):**
- Minimal scopes: `read_products`, nothing else. No write scope on the app at all.
- Admin API access needed? Only for product reads. With `read_products` the chat can serve cards even when the core connection is gone (state 4 improves).
- Tenant resolution: **not** via OAuth. The merchant pastes the public channel key into the App Embed; the server matches key → channel → tenant, then verifies `Origin`. The OAuth install only proves the shop installed the app.
- Connecting to the core: by `shopDomain`. The channel's `config.shopDomain` is written once at creation from the core connection and is not patchable; the `store_binding` diagnostic already enforces agreement.
- Two installs for merchants: yes. Install → activate embed → paste key.
- Duplicate installs: guard on `shopDomain` — one chat installation row per shop, and refuse to bind a shop already bound to a different tenant.
- Uninstall: a second handler on the chat app's own secret; it disables the channel and never touches `TenantIntegration`.

---

## 8. Data ownership

**Core Integration owns** (Chat may never read these directly):
- the store OAuth token and refresh token
- Admin API access and the entire tool surface
- product / order / customer / refund / return operations
- the store-to-tenant binding (`TenantIntegration.config.shopDomain`)
- commerce permissions and scope state

**Chat system owns:**
- the public channel identifier (`ChannelAccount.externalId`)
- widget configuration (`platformMeta.shopifyLiveChat`)
- visitor session and `visitorId`
- conversation state and message history
- App Embed activation state (`install.lastHeartbeatAt`)
- human handoff state

**Shared backend may expose to Chat only** the `ProductSnapshot` projection:
title, handle, image, price, compare-at price, currency, variant list with
`available` booleans, publish status. Never a raw Admin payload, never a token,
never an inventory count, never a customer or order object.

---

## 9. Product licensing separation

Do **not** treat a connected store as a licence to chat. Four capabilities,
four keys:

| Key | Covers | Recommended packaging |
|---|---|---|
| `shopify_core_integration` | OAuth, product/inventory reads, store binding, agent order context | **Included** wherever integrations are sold (today's `manager.integrations` tier) |
| `shopify_live_chat` | Theme extension, App Embed, storefront chat, visitor session, handoff | **Chat add-on**, or bundled into `communication.omnichannel` for plans that already sell every channel |
| `shopify_product_messaging` | Product cards, carousel, variant selection, Add to Cart | **Commerce add-on** — this is the revenue-adjacent capability, and it already degrades cleanly when absent |
| `shopify_order_actions` | Order lookup/cancel, customer writes, refunds, returns, discounts | **Selected paid plans only.** These move money and touch protected customer data; they should never ride in on a chat purchase |

Recommendation: **not one bundled entitlement, and not "included with
omnichannel"**. Chat and Commerce are separately valuable and separately risky.
Sell `shopify_live_chat` as a Chat add-on and `shopify_product_messaging` as a
Commerce add-on; keep `shopify_order_actions` on paid tiers with HITL.

Implementation note: define these in `feature-catalog.ts` using **exactly** the
runtime flag names, so `materializeEntitlements()` writes the same
`TenantFeature` rows that `requireFeature()` already reads. That closes the
class of bug found on 2026-07-28, where a gate read a flag no provisioning path
ever wrote.

---

## 10. Recommendation

> **Two separate Shopify apps: keep the GOTCHA Core Shopify Integration exactly
> as it is, and ship the Theme App Extension in a dedicated GOTCHA Shopify Chat
> App holding `read_products` and nothing else.**

**Why.** The storefront runtime already needs zero Admin privilege of its own,
and its single Admin need is one read scope. Riding the core app would make
every chat merchant grant refund, discount and customer-write authority to put
a chat bubble on their storefront, and would chain the chat's App Store
availability to the core connector's Protected Customer Data review — which is
a known live blocker. The separate manifest already exists in the repo
(`shopify-app/shopify.app.toml`, `scopes = "read_products"`) and the code
already reads a distinct client id (`SHOPIFY_APP_CLIENT_ID`), so this is the
direction the implementation was already pointed at; it is unfinished, not
undecided.

**Security implications.** Isolation stops being a policy ("no storefront path
may call a write tool") and becomes structural: the Chat App holds a token with
no write scope, so a routing defect cannot escalate into a refund. The Core
token stays reachable only from authenticated, tenant-scoped, HITL-gated paths.
Rule to enforce: **chat product reads use the Chat App token; the Core token is
never used by a storefront-originated request.**

**Merchant UX.** Two installs instead of one. The second is deliberately
lightweight — install, activate the App Embed, paste the channel key — and the
merchant is already in the Theme Editor for step two regardless of topology.
Fixing `SHOPIFY_APP_CLIENT_ID` (F3) restores the one-click Theme Editor deep
link, which matters more to setup time than the extra install.

**Migration impact.** Effectively zero, and this window will not reopen: there
is **no chat installed base**, and the core app's client id, secret, scopes,
redirect URI and tokens are untouched. No merchant reauthorizes anything.

**Scope impact.** Core keeps its seven scopes (and should add `write_customers`,
which its tools already require and never received). Chat requests
`read_products` only.

**Deployment model.** Two Partner apps in one organization. The chat app owns
`shopify-app/` and is the only thing `shopify app deploy` may ever target. The
core app's configuration is managed in the Partner dashboard and must not be
driven from this repo while `include_config_on_deploy = true` (F2).

**Entitlement model.** Four keys as in §9, defined in the sellable catalog under
their runtime names.

**Uninstall behaviour.** Two handlers, two secrets, two consequences: chat
uninstall disables the channel and leaves commerce running; core uninstall marks
the connection `DISCONNECTED`, withdraws the tool surface, and degrades chat to
text-only. Neither exists today and both are required before any real merchant
installs either app.

### Condition under which Option 1 wins instead

If GOTCHA decides Shopify Chat will **never** be sold or listed independently of
the platform — every chat merchant must already run GOTCHA with a connected
store — then the second install is friction with no return, and folding the
extension into the core app is the cheaper, coherent choice. That is a
commercial decision, not a technical one. It should be made explicitly rather
than by default.

---

## 11. Implementation status — 2026-07-28

The two-app split below is now BUILT (branch
`scratch/shopify-live-chat-on-pricing`, unpushed, undeployed):

| Item | State |
|---|---|
| Dedicated Chat identity (`SHOPIFY_CHAT_APP_*`) | built, wired into both compose files |
| `/api/connectors/shopify-chat/oauth/{init,callback}` with HMAC + single-use state | built, tested |
| `ShopifyChatInstallation` model + migration (partial unique index: one live install per shop) | built, applied to dev |
| Tenant binding via membership + `channels:manage:update` + entitlement | built, tested |
| Automatic channel create/reuse, automatic domain recording | built, tested |
| Bootstrap by `shop.permanent_domain` (no channel key) | built, tested |
| `productMessaging: false` when Core is disconnected | built, tested |
| Chat `app/uninstalled` + 3 mandatory compliance webhooks | built, tested |
| Core `app/uninstalled` (separate secret, separate consequence) | built, tested |
| Theme Editor deep link from the CHAT client id + `gotcha_chat` block | built |
| Merchant onboarding wizard at `/shopify/chat/install` | built |
| Deployment safety check refusing the Core client id | built |
| Four distinct entitlement keys | keys defined; `shopify_order_actions` NOT yet enforced on Core write tools (deliberate — see below) |

Still open: the Partner apps do not exist yet, so no `client_id` is
linked and nothing has been deployed. Wiring `shopify_order_actions` into
the Core tool dispatch changes live refund/cancel behaviour and is held
for explicit approval.

## 12. Remediation backlog (ordered, blocking first)

1. **Do not run `shopify app deploy` from this repo until the chat app has its
   own client id in the Partner dashboard.** With `include_config_on_deploy =
   true`, deploying against the core app rewrites its scopes and redirect
   allowlist and breaks every connected store. (F2)
2. Fix `shopify-app/shopify.app.toml`: correct `redirect_urls` to the real
   `/api/connectors/shopify/oauth/callback` on the correct host, or drop the
   `[auth]` block entirely if the chat app takes the zero-Admin variant.
3. Add `SHOPIFY_APP_CLIENT_ID` and `SHOPIFY_CHAT_BLOCK_HANDLE` to
   `docker-compose.yml`, `docker-compose.prod.yml` and both env files. Until
   then the Theme Editor deep link is `null` everywhere. (F3)
4. Implement `app/uninstalled` for both apps, HMAC-verified against the
   matching app secret. Core → `DISCONNECTED`; Chat → channel disabled. (F4)
5. Add the four entitlement keys to `feature-catalog.ts` under their runtime
   names, then revisit the `defaultEnabled: true` set on 2026-07-28 — once every
   plan carries the keys, materialized rows make the default irrelevant.
6. Make state 4 honest: when the core connection is missing, the bootstrap
   should report `productMessaging: false` rather than advertising cards the
   server will refuse.
7. Tighten the App Embed signal: a 7-day heartbeat window means a theme change
   can leave "activated" showing for a week. A shorter window, or an explicit
   re-check on theme id change, keeps state 9 truthful.
8. Request `write_customers` for the core app — its tool surface has required
   it since it was written and has been 403ing in production paths.
