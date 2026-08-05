# Shopify Core / Chat unification audit

**Date:** 2026-08-04
**Type:** Read-only architecture and migration audit. **No code, no Shopify app, no environment variable and no deployment was changed by this task.**
**Question:** should the storefront Chat widget keep its own Shopify app, or move into GOTCHA Core as an optional channel?

> ## Decision approved - 2026-08-04 (see Section 21)
>
> **Option B is approved.** The existing **GOTCHA** app (client `b1ce3aa5…5f76`) becomes the single unified production Shopify app. No `GOTCHA Chat Production` app will be created; the Chat Dev app will not be used for production; no replacement Core app will be created.
>
> Execution detail lives in **`docs/setup/shopify-core-unified-production-runbook.md`**.
>
> Section 21 records live evidence gathered after this audit was first written. Two findings materially change the plan: the app has **already been granted all 25 target scopes**, and the OAuth code requests only 15, so **the app configuration - not the code - is already authoritative for scopes**.

Evidence legend used throughout:

| Mark | Meaning |
|---|---|
| **[R]** | Confirmed repository fact (file + line read) |
| **[L]** | Confirmed live fact (dev database or CLI output observed) |
| **[I]** | Inferred from repository evidence |
| **[?]** | Unknown from here, requires live Shopify/Partner verification |

---

## 1. Executive summary

The separate Chat app is **no longer justified by its original rationale**, and the rationale is recorded in the repo well enough to prove that.

`docs/architecture/shopify-core-vs-chat-app.md` (2026-07-28) recommended two apps. Its decisive argument was finding **F5, "Scope asymmetry"**: Chat needed `read_products`, Core needed seven scopes including `write_orders`, so riding Core would make a chat merchant grant refund and discount authority to place a chat bubble. That was a real argument when written.

It is no longer true. The Chat manifest today requests **`scopes = ""`** in both production and development configs **[R]**, and the data model records why: *"Encrypted Chat access token, only when the app actually requests scopes. Version 1 requests none, so this is null and there is nothing to leak"* **[R]**. The Chat app holds no Shopify Admin token and needs none.

Once the scope count is zero, the scope-isolation argument does not shrink, it **disappears**. There is nothing to isolate. What the second app still buys is narrower than the old document claims:

1. ownership of the Theme App Extension,
2. its own secret for app-proxy and webhook HMAC,
3. an independent uninstall lifecycle (uninstall Chat, keep commerce),
4. the option of a standalone App Store listing.

Items 1 to 3 are all achievable inside Core. Item 4 is a commercial decision, and the old document said so explicitly: *"If GOTCHA decides Shopify Chat will never be sold or listed independently of the platform... folding the extension into the core app is the cheaper, coherent choice. That is a commercial decision, not a technical one."*

The premise supplied with this audit is that Chat is a channel inside GOTCHA, not a standalone product. Under that premise the document's own stated condition for Option 1 is met.

**Migration cost is close to its floor right now.** There is no production Chat app **[R/L]**, no production Chat installation, and exactly one dev installation on a demo store **[L]**. This window does not reopen once merchants install.

**The one genuinely dangerous part is not the Chat side.** It is that unification makes the repo's TOML authoritative over the **Core** app, and that TOML carries `include_config_on_deploy = true` **[R]**. A careless `shopify app deploy` would then overwrite Core's live scope list and redirect allowlist for every connected store. This is rated CRITICAL and has a concrete mitigation (Section 13).

**Verdict: GO for unification (Option B)**, conditional on four blockers in Section 20.

---

## 2. Current architecture diagram

```
                         ┌──────────────────────────────────────────┐
                         │        Shopify Partner organization       │
                         │                                          │
  ┌──────────────┐       │  ┌────────────────┐  ┌────────────────┐  │
  │  Merchant    │──1──▶ │  │ GOTCHA Core    │  │ GOTCHA Chat    │  │
  │  admin       │       │  │ client …5f76   │  │ (Dev) …c3ad    │  │
  └──────────────┘       │  │ 16 scopes      │  │ scopes = ""    │  │
         │               │  │ dashboard-     │  │ owns theme     │  │
         │               │  │ managed config │  │ extension      │  │
         2               │  └────────────────┘  └────────────────┘  │
         │               │                      ┌────────────────┐  │
         ▼               │                      │ GOTCHA Chat    │  │
  ┌──────────────┐       │                      │ PRODUCTION     │  │
  │  Merchant    │──3──▶ │                      │ DOES NOT EXIST │  │
  │  theme editor│       │                      └────────────────┘  │
  └──────────────┘       └──────────────────────────────────────────┘
                                    │                     │
              Admin API (token)     │                     │  app proxy + webhooks
                                    ▼                     ▼   (Chat secret)
                         ┌───────────────────────────────────────────┐
                         │              services/ai                  │
                         │  TenantIntegration(slug=shopify)  ◀── Core│
                         │  ShopifyChatInstallation          ◀── Chat│
                         │                                           │
                         │  product truth for the widget is read     │
                         │  through the CORE connection ─────────────┼──▶ coupling
                         └───────────────────────────────────────────┘

1 = Core OAuth install    2 = second Chat OAuth install    3 = activate App Embed
```

The arrow marked "coupling" is the important one: the storefront's only Admin need is already served by the Core token, not by the Chat app.

---

## 3. Current Core flow

| # | Step | Evidence |
|---|---|---|
| 1 | Merchant connects Shopify in GOTCHA | `services/ai/src/routes/connectors-admin.ts` **[R]** |
| 2 | OAuth init `GET /api/connectors/shopify/oauth/init?shop=` | authenticated, tenant-scoped **[R]** |
| 3 | App identity `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` (client `…5f76`) | `.env.prod` **[R]** |
| 4 | Callback `GET /api/connectors/shopify/oauth/callback` | `connectors-admin.ts` **[R]** |
| 5 | Token stored AES-encrypted in `TenantIntegration.credentials` | `encryptCredentials` **[R]** |
| 6 | Shop bound to tenant via `TenantIntegration.config.shopDomain` | **[R]** |
| 7 | Scopes verified / capability probe, `grantedScopes` recorded | `commerce-context.service.ts` reads `config.grantedScopes` **[R]** |
| 8 | Tools provisioned through `executeAdapterTool` | `shopify.adapter.ts`, 45+ tools **[R]** |
| 9 | Webhooks: `app/uninstalled` + 3 compliance topics on the **Core** secret | `shopify-webhooks.ts:278,325,333,341` **[R]** |
| 10 | Customer / order / product data available | `shopify.adapter.ts` **[R]** |
| 11 | Write actions available (cancel, refund, returns, exchanges, tags, notes) | **[R]** |
| 12 | Disconnect sets `DISCONNECTED`; reconnect re-binds by `shopDomain` | `shopify-webhooks.ts:289-305` **[R]** |

**Scopes requested by Core** (`connectors-admin.ts`) **[R]**:

```
read_orders, write_orders, read_all_orders,
read_customers, write_customers,
read_merchant_managed_fulfillment_orders, read_assigned_fulfillment_orders,
read_inventory,
read_price_rules, write_price_rules, write_discounts,
read_products,
read_returns, write_returns,
write_order_edits
```

**Is Core already the canonical Shopify identity?** Yes for every item asked:

| Capability | Canonical owner today |
|---|---|
| customer lookup | Core **[R]** |
| order lookup | Core **[R]** |
| product search | Core **[R]** |
| inventory | Core **[R]** |
| cancellations | Core **[R]** |
| refunds | Core **[R]** |
| returns | Core **[R]** |
| exchanges | Core **[R]** |
| customer notes | Core **[R]** |
| tags | Core **[R]** |
| webhooks (commerce + compliance) | Core, own secret **[R]** |
| compliance webhooks | **Both** apps implement the trio separately **[R]** |
| storefront customer identity | **Chat**, via app proxy signature **[R]** |

Only the last row belongs to Chat, and it depends on a *secret*, not on a scope or a token.

---

## 4. Current Chat flow

| # | Step | Evidence |
|---|---|---|
| 1 | Extension owned by the Chat app | `shopify-app/shopify.app.toml` + `extensions/gotcha-chat/` **[R]** |
| 2 | Theme App Extension, App Embed block `gotcha_chat.liquid`, uid `5f510f68-…` | `shopify.extension.toml` **[R]** |
| 3 | Widget loads from `app.gotcha.co.il` asset base | `frontend/public/widget/gotcha-shopify-bootstrap.js` **[R]** |
| 4 | Shop identified by `shop.permanent_domain` at bootstrap | `shopify-chat-public.ts` **[R]** |
| 5 | App-proxy requests verified with `verifyAppProxySignature(query, clientSecret)` using the **Chat** secret | `shopify-chat-public.ts:385-387` **[R]** |
| 6 | Storefront session is AES-256-GCM encrypted; browser holds an opaque token | `shopify-chat-public.ts` **[R]** |
| 7 | Customer identity only from a Shopify-signed proxy call at `GET /proxy/identity` | `shopify-chat-public.ts:384` **[R]** |
| 8 | Messages enter via the public chat routes under `/api/shopify-chat` | `services/ai/src/index.ts:139` **[R]** |
| 9 | Conversation assigned to tenant + `SHOPIFY_LIVE_CHAT` channel | `ChannelType.SHOPIFY_LIVE_CHAT`, `ChannelAccount.platformMeta` **[R]** |
| 10 | Backend service: `services/ai` | `index.ts:137-140` **[R]** |
| 11 | Runtime identity: `SHOPIFY_CHAT_APP_CLIENT_ID` / `_SECRET` | `shopify-chat-app.ts:45-47` **[R]** |
| 12 | Chat has its **own** record `ShopifyChatInstallation`, and deliberately never reads `TenantIntegration` | `shopify-chat-install.service.ts:10` **[R]** |
| 13 | Uninstall/disable: Chat `app/uninstalled` retires the install and disables the channel; Core stays connected | `shopify-webhooks.ts:150-158` **[R]** |
| 14 | **Chat requires a second OAuth install today.** A Theme App Extension can only be activated for an installed app | `shopify-chat-install.ts` + Shopify platform rule **[R/I]** |
| 15 | **Merchant sees two Shopify connections**: Integrations (Core) and Channels → Shopify Live Chat, plus a wizard at `/shopify/chat/install` | `frontend/src/app/shopify/chat/install/page.tsx`, `ShopifyLiveChatSettings.tsx` (895 lines) **[R]** |

**Product truth coupling [R]:** the widget's product cards and Add-to-Cart validation are served by `shopify-catalog.service.ts` through `loadConnection({slug:"shopify"})`, i.e. **the Core token**. Chat's own app contributes no Admin access whatsoever.

---

## 5. App identity matrix

| Property | GOTCHA Core (prod) | Core (dev) | GOTCHA Chat (Dev) | Chat Production | Legacy/staging |
|---|---|---|---|---|---|
| Exists? | **Yes [L]** | Same app, different redirect **[R]** | **Yes [L]** `…c3ad` | **No. Never created [R/L]** | None found **[R]** |
| App name | GOTCHA Core Shopify Integration | same | GOTCHA Chat (Dev) | intended `GOTCHA Chat Production` | - |
| Client ID | `…5f76` **[R]** | `…5f76` **[R]** | `96c9417a…c3ad` **[R]** | none | - |
| Organization | omer.serruya@gotcha.co.il **[L]** | same | same **[I]** | n/a | - |
| Config file | **none in repo** (dashboard-managed) **[R]** | none | `shopify.app.dev.toml` **[R]** | `shopify.app.toml` (unlinked) **[R]** | - |
| Env vars | `SHOPIFY_API_KEY/_SECRET/_REDIRECT_URI` **[R]** | same | `SHOPIFY_CHAT_APP_*` in `.env` **[R]** | `SHOPIFY_CHAT_APP_CLIENT_ID/_SECRET` **empty** in `.env.prod` **[R]** | - |
| Scopes | 16 **[R]** | 16 | **`""`** **[R]** | **`""`** **[R]** | - |
| Redirect URLs | `/api/connectors/shopify/oauth/callback` **[R]** | dev host | `dev.gotcha.co.il/api/connectors/shopify-chat/oauth/callback` **[R]** | `app.gotcha.co.il/...` **[R]** | - |
| App URL | dashboard **[?]** | - | `dev.gotcha.co.il/api/connectors/shopify-chat/oauth/init` **[R]** | `app.gotcha.co.il/...` **[R]** | - |
| App proxy | **[?]** unknown; none declared in repo | - | `/api/shopify-chat/proxy`, subpath `gotcha-chat` **[R]** | same **[R]** | - |
| Webhooks | 4 topics on Core secret **[R]** | same | 4 topics on Chat secret **[R]** | 4 declared **[R]** | - |
| Theme extension | none | none | `gotcha-chat`, uid `5f510f68-…` **[R]** | same uid declared **[R]** | - |
| Deploy scripts | none (dashboard) | - | `shopify app deploy` from `shopify-app/` **[R]** | same | - |
| Verify script | - | - | `verify-chat-app-identity.mjs --config shopify.app.dev.toml` → ✓ **[L]** | same, → ✗ REFUSING **[L]** | - |
| Installed on | 3 tenant rows, all `urban-supply-gotcha-demo.myshopify.com`, `CONNECTED` **[L]** | - | 1 install, `urban-supply-gotcha-demo`, `ACTIVE`, bound **[L]** | none | - |

Production installed base for Core is **[?]** from here (prod DB not queried; this audit made no production reads).

---

## 6. Scope comparison

| Scope | Core uses it | Chat uses it | Chat-only | Required at install | Optional | Actual code path |
|---|---|---|---|---|---|---|
| `read_products` | Yes | **indirectly, via Core's token** | **No** | Core: yes | - | `shopify-catalog.service.ts` → `loadConnection(slug:"shopify")` **[R]** |
| `read_orders` / `read_all_orders` | Yes | No | No | Core: yes | - | `shopify.adapter.ts` |
| `write_orders` | Yes | No | No | Core: yes | - | cancel, refund, edits |
| `read_customers` / `write_customers` | Yes | No | No | Core: yes | - | tags, notes, profile |
| `read_returns` / `write_returns` | Yes | No | No | Core: yes | - | returns, exchanges |
| `read_price_rules` / `write_price_rules` / `write_discounts` | Yes | No | No | Core: yes | - | discounts |
| `read_inventory` | Yes | No | No | Core: yes | - | `inventory_status` |
| fulfillment-order scopes | Yes | No | No | Core: yes | - | fulfilment status |
| `write_order_edits` | Yes | No | No | Core: yes | - | exchanges |
| **(any Chat scope)** | - | **none declared** | - | **Chat: none** | - | `scopes = ""` **[R]** |

**Direct answers:**

- **Does Chat require any Admin scope Core does not already require?** **No.** Chat declares zero scopes **[R]**. Its only Admin need (product reads) is already satisfied by Core's `read_products` through a server-side projection **[R]**.
- **Does moving Chat into Core increase permissions shown to an existing Core customer?** **No.** Adding a Theme App Extension does not change the scope list, so no consent screen changes and no reauthorization is triggered **[I, standard Shopify behaviour; mark [?] for live confirmation]**.
- **Does the Theme App Extension itself require a separate OAuth scope?** **No.** No scope is associated with theme extensions; the requirement is that the owning app is *installed* **[I]**.
- **Does the app proxy require a separate app identity?** **No.** It requires *an* app with a proxy configured and its client secret for signature verification. Core can hold it **[R: `verifyAppProxySignature(query, secret)` is secret-parametric]**.
- **Is any current Chat scope unnecessary once Chat reuses Core?** There are no Chat scopes to remove. The `[access_scopes] scopes = ""` block and the `accessToken`/`tokenScopes` columns on `ShopifyChatInstallation` become permanently dead **[R]**.

**There are no Chat-only scopes. Stated plainly, as requested.**

---

## 7. Why the split exists

| Candidate reason | Verdict | Evidence |
|---|---|---|
| Different scopes | **Was true, now false** | F5 in the 2026-07-28 doc assumed Chat needs `read_products`; manifest now says `scopes = ""` **[R]** |
| Actual product requirement | **No** | Chat is exposed as a GOTCHA channel (`ChannelType.SHOPIFY_LIVE_CHAT`), not a standalone product **[R]** |
| Different OAuth lifecycle | **Partly real** | Chat install is its own record and can be uninstalled independently **[R]** |
| Shopify CLI limitation | **No** | One app can own many extensions **[I]** |
| Theme App Extension ownership | **Real but not exclusive** | Any app can own it; Core has none today **[R]** |
| Separate App Store listing strategy | **Real, and the deciding factor** | Old doc: chat listable on `read_products` alone, independent of Core's Protected Customer Data review **[R]** |
| Separate billing | **No** | Billing is GOTCHA-side; entitlement keys are app-topology independent **[R]** |
| Standalone Chat product strategy | **Commercial, currently negated** | Premise supplied: Chat is a channel inside GOTCHA |
| Development convenience | **Minor** | Dev app lets the extension be deployed without touching Core **[R]** |
| Historical accident | **Partly** | Old manifest had wrong host and path (F1) and an unset second client id (F3) **[R]** |
| Safety around deploying the wrong TOML | **Real, and inverted by unification** | `include_config_on_deploy = true` + verifier refusing Core's id **[R]** |
| Incomplete migration | **Yes** | §11 of the old doc: "the Partner apps do not exist yet, so no client_id is linked and nothing has been deployed" **[R]** |

**Classification: BENEFICIAL BUT OPTIONAL, degrading to HISTORICAL.**

It was a defensible decision on 2026-07-28 under a `read_products` Chat app and an App-Store-listing ambition. The scope premise has since been removed from the code and the listing ambition is withdrawn by the premise of this audit. What remains is deployment-safety habit and an unfinished migration, not a requirement.

The two things genuinely lost by unifying are recorded honestly in Section 12: independent uninstall, and independent App Store listing.

---

## 8. Unified target architecture

**Assessment: it fits the existing repository well.** Most of the machinery is already topology-independent.

| Proposed element | Fit | Note |
|---|---|---|
| One production app (Core) owns OAuth, token, scopes, webhooks, app proxy, extension | **Good** | Only the proxy and extension are new to Core |
| Chat as Settings → Channels → Shopify Chat, enable/disable | **Already exists** | `ShopifyLiveChatSettings.tsx` (895 lines) + `/settings/channels/shopify-live-chat` **[R]** |
| Merchant connects Shopify once | **Achievable** | Removes the `/shopify/chat/install` wizard **[R]** |
| Reuse Core integration record, token, context, tools | **Already true** | Product truth already comes from Core **[R]** |
| Extension deployed as part of Core | **Requires new deploy discipline** | Section 13 |

**Proposed state machine vs what exists:**

| Proposed state | Exists today? | Backing signal |
|---|---|---|
| `unavailable` | Yes | entitlement `shopify_live_chat` **[R]** |
| `shopify_not_connected` | Partly | `loadConnection` returns null; today the bootstrap does **not** check it **[R]** |
| `extension_not_deployed` | No | needs app-version awareness **[?]** |
| `ready_to_activate` | Yes | install row exists, no heartbeat **[R]** |
| `activation_required_in_theme` | Yes | `app_embed: blocked` diagnostic **[R]** |
| `active` | Yes | `lastHeartbeatAt` within 7 days **[R]** |
| `degraded` | Partly | Core disconnected → cards fail; old doc §12 item 6 says bootstrap still advertises `productMessaging: true` **[R]** |
| `disabled` | Yes | channel `enabled` flag **[R]** |

The state model is a superset of what exists and is a genuine improvement, independent of the unification decision.

---

## 9. Required code changes

| # | Change | Area | Complexity |
|---|---|---|---|
| C1 | Point app-proxy verification at the Core secret | `shopify-chat-public.ts:385` | **MEDIUM** (security-critical, 1 line + tests) |
| C2 | Collapse 8 webhook handlers to 4; single `app/uninstalled` must apply **both** consequences | `shopify-webhooks.ts` | **HIGH** (semantics change) |
| C3 | Retire the Chat OAuth init/callback routes | `shopify-chat-install.ts` | **MEDIUM** |
| C4 | Derive install state from `TenantIntegration` instead of a second OAuth | `shopify-chat-install.service.ts` | **HIGH** |
| C5 | Keep `ShopifyChatInstallation` as widget/activation state only; drop `accessToken`/`tokenScopes` | schema + service | **MEDIUM** |
| C6 | Rewrite `verify-chat-app-identity.mjs`: today it **refuses when the linked id equals Core** (`line 130`) which forbids the target design | `scripts/shopify/` | **MEDIUM** |
| C7 | Theme Editor deep link to use Core client id | `shopify-live-chat.ts` | **LOW** |
| C8 | Remove `/shopify/chat/install` wizard; move enable/disable into Channels | `frontend/src/app/shopify/chat/install/`, `ShopifyLiveChatSettings.tsx` | **MEDIUM** |
| C9 | Honest `productMessaging:false` and `shopify_not_connected` state | `shopify-chat-public.ts` | **LOW** |
| C10 | Env: retire `SHOPIFY_CHAT_APP_CLIENT_ID/_SECRET`; add `SHOPIFY_CHAT_BLOCK_HANDLE` if still absent from compose | `.env*`, compose | **LOW** |
| C11 | Create `shopify.app.production.toml` carrying **Core's full 16 scopes and real redirect URLs** | `shopify-app/` | **CRITICAL** |

---

## 10. Required Shopify Dashboard / CLI changes

| # | Change | Complexity | Note |
|---|---|---|---|
| D1 | Add an App Proxy to the Core app (`/apps/gotcha-chat` → `https://app.gotcha.co.il/api/shopify-chat/proxy`) | **MEDIUM** | **[?]** Core's current proxy config unknown |
| D2 | Add the four Chat webhook subscriptions to Core, or re-point them | **MEDIUM** | Compliance trio must stay answered |
| D3 | Recreate the Theme App Extension under Core | **HIGH** | See Section 15 |
| D4 | Create a **GOTCHA Core Dev** app if one does not exist | **MEDIUM** | **[?]** today Core prod/dev share `…5f76` **[R]** |
| D5 | Retire `GOTCHA Chat (Dev)` `…c3ad` after migration | **LOW** | Uninstall from demo store first |
| D6 | Do **not** create `GOTCHA Chat Production` | - | Cancels the in-flight task; nothing was created **[L]** |

---

## 11. Data migration needs

| Item | Impact | Complexity |
|---|---|---|
| `ShopifyChatInstallation` rows | 1 row, dev, `app_identity='gotcha-chat-dev'` **[L]** | **LOW** |
| `app_identity` column | Already exists and is *"future-proofs a second surface"* **[R]**; becomes `gotcha-core` | **LOW** |
| `accessToken` / `tokenScopes` | Always null **[R]**; drop or leave dead | **LOW** |
| `ChannelAccount` (SHOPIFY_LIVE_CHAT) | Keyed by public channel key, not app id | **LOW** |
| Shop domain uniqueness | Partial unique index, one live install per shop **[R]** | **LOW** |
| Conversations | Keyed by visitor id, no app reference | **NONE** |
| Production Chat installs | **Zero** - app never existed **[R/L]** | **NONE** |
| Backfill | One dev row, or simply reinstall on the demo store | **LOW** |

**This is the single strongest argument for acting now.** Migration is one dev row. After the first production merchant installs a Chat app, this becomes a HIGH-complexity merchant-action migration.

---

## 12. Existing merchant impact

| Case | Installation | OAuth | Reauth? | Re-enable embed? | Conversations | Channel migration | Uninstall old app | Downtime | Rollback |
|---|---|---|---|---|---|---|---|---|---|
| 1. Core installed, Chat not | Add extension to Core | none | **No** **[I]** | n/a (never enabled) | n/a | none | n/a | none | trivial |
| 2. Core + separate Chat installed | **Does not exist in production [R/L]** | - | - | - | - | - | - | - | - |
| 3. Chat without Core | **Impossible in production** (no prod Chat app) | - | - | - | - | - | - | - | - |
| 4. Dev/test store on Chat Dev | Reinstall extension under Core dev | new install | Yes (dev only) | **Yes** | preserved (visitor-keyed) | 1 row | Yes | dev only | recreate |
| 5. New merchant post-unification | One install + activate embed | one | n/a | once | n/a | none | n/a | none | n/a |

**Because no production Chat app or installation exists, cases 2 and 3 are empty and the migration reduces to case 1 (no merchant action at all) plus case 4 (one dev store).** That removes the entire class of merchant-facing migration risk.

**What is genuinely lost:**
- Independent uninstall. Under one app, uninstalling Core removes the extension and kills the widget. Today a merchant could drop Chat and keep commerce. This is a real regression and should be an explicit product acceptance.
- Independent App Store listing for Chat.

---

## 13. Security implications

Reviewed against each item requested.

| Property | Effect of unification | Risk |
|---|---|---|
| Tenant isolation | Unchanged. Resolution is by `shopDomain` / public channel key, not app id **[R]** | None |
| Shop-to-tenant resolution | Unchanged **[R]** | None |
| App-proxy verification | Secret swaps Chat → Core. `verifyAppProxySignature(query, secret)` is already secret-parametric **[R]** | **MEDIUM**, one line, must be tested |
| Webhook HMAC | 2 secrets → 1. **The dangerous part**: today `/api/shopify-chat/webhooks/*` uses Chat's secret and `/api/connectors/shopify/webhooks/*` uses Core's **[R]**. If both point at Core's secret but the *routes* remain distinct, a chat-uninstall payload could be accepted on the commerce route | **HIGH** |
| OAuth state validation | Chat's OAuth is removed entirely; Core's is untouched **[R]** | Reduced surface |
| Token encryption | Unchanged; Chat's always-null token column disappears **[R]** | Reduced surface |
| Uninstall handling | **Semantics change.** One uninstall must now do both consequences | **HIGH** |
| Channel authorization | Unchanged (entitlement + channel flag) **[R]** | None |
| Storefront session security | Unchanged. Uses `WIDGET_SESSION_SECRET`/`JWT_SECRET`, not an app secret **[R]** | None |
| Customer identity matching | Unchanged mechanism, different secret | **MEDIUM** |

**Secret-selection sites that must all move together** (this is the list asked for):

1. `shopify-chat-public.ts:385` - `getShopifyChatAppConfig().clientSecret` for app proxy **[R]**
2. `shopify-webhooks.ts:158,188,203,222` - Chat secret for 4 topics **[R]**
3. `shopify-webhooks.ts:278,325,333,341` - Core secret for 4 topics **[R]**
4. `shopify-chat-app.ts:45-47` - the config reader itself **[R]**

**The specific failure mode to design against:** `getShopifyChatAppConfig()` returns `""` when unset **[R]**, and `verifyAppProxySignature` returns `false` on an empty secret **[R]** - that fails closed, which is correct. But if unification is done by *pointing `SHOPIFY_CHAT_APP_SECRET` at the Core secret value* rather than by deleting the indirection, the system silently keeps two names for one secret, and a future rotation of one will break the other with a signature error that reads as "misconfigured proxy". **Recommendation: delete the Chat config reader outright rather than aliasing it.**

**Net security assessment:** unification is close to neutral, and mildly *positive* on surface area (one fewer OAuth flow, one fewer secret, one fewer token column). The old document's claim that the split gives "structural" isolation no longer holds: the widget's product reads already flow through the Core token **[R]**, so the isolation is already policy-level for the one Admin capability Chat uses.

---

## 14. Deployment plan

Ordered, each step reversible before the next.

1. **Freeze.** Do not create `GOTCHA Chat Production`. (Already true - nothing was created **[L]**.)
2. **C11 first.** Author `shopify.app.production.toml` containing Core's **exact 16 scopes** and real redirect URLs. Until this file is byte-correct, no deploy may run.
3. **Rewrite the verifier (C6)** to assert the linked id **equals** Core and that the scope list matches the code's list exactly. Invert the current `!==` assertion.
4. **Dashboard (D1, D2):** add app proxy and webhook subscriptions to Core.
5. **Deploy the extension to a Core *dev* app (D4)** and verify on the demo store.
6. **Backend (C1–C5, C7, C9, C10)** behind a flag; keep Chat routes answering until cutover.
7. **Frontend (C8).**
8. **Production deploy** of the extension to Core.
9. **Retire the Dev Chat app (D5).**

---

## 15. Critical Shopify constraints

| Question | Expected behaviour | Confidence |
|---|---|---|
| Can a Theme App Extension be moved between apps? | **No.** Extensions are registered to an app; there is no transfer | **[I]**, needs **[?]** confirmation |
| Must it be recreated under Core? | **Yes** | **[I]** |
| Does the extension UID change? | **Yes.** `uid = "5f510f68-…"` is per-app registration **[R]**; recreating mints a new one | **[?]** |
| Must merchants re-enable the embed? | **Yes for anyone who had the old app.** Today that is one dev store **[L]** | **[I]** |
| Can `shopify app deploy` against Core modify Core's scopes/URLs/webhooks? | **Yes, and this is the CRITICAL risk.** `include_config_on_deploy = true` **[R]** | **[R]** |
| Can the current verifier support the unified model? | **No.** It hard-fails when `manifest.clientId === coreClientId` (`line 130`) **[R]** | **[R]** |
| Is a separate production config file needed? | **Yes** - and it must carry Core's full scope list | **[R]** |
| Does the verifier wrongly assume Chat must be separate? | **Yes.** Its central assertion is "core client id ← must differ" (`line 269`) **[R]** | **[R]** |

---

## 16. Rollback plan

| Stage | Rollback |
|---|---|
| Before extension deploy | Delete the new TOML. Nothing external changed |
| After Core dev deploy | Remove the extension version from the dev app; prod untouched |
| After Core prod extension deploy | Publish the previous Core app version. Extension disappears; **scopes are the exposure** - hence C11 must be right first |
| After backend cutover | Feature flag back to Chat-app paths; requires Chat app to still exist, so **keep `…c3ad` until cutover is proven** |
| After Dev Chat retirement | Point of no return for dev testing |

---

## 17. Testing plan

- Unit: app-proxy signature against the Core secret; both HMAC schemes (`hex`/no-separator for proxy, `base64` raw body for webhooks) **[R]**.
- Unit: single `app/uninstalled` applies **both** consequences.
- Regression: existing suites `shopify-chat-cors`, `shopify-chat-identity`, `shopify-chat-public`, `shopify-chat-install`, `shopify-webhooks` **[R]**.
- Integration on demo store: install Core dev → activate embed → widget loads → logged-in shopper identity resolves → uninstall → channel disabled **and** integration `DISCONNECTED`.
- Negative: empty secret fails closed; chat-uninstall payload rejected on the commerce route.
- Scope regression: after `shopify app deploy`, re-read Core's granted scopes and assert all 16 survive. **This is the test that protects every connected merchant.**

---

## 18. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | Deploy overwrites Core scopes/redirects for every connected store | **CRITICAL** | C11 + rewritten verifier + post-deploy scope assertion |
| R2 | Single uninstall wrongly kills commerce or wrongly leaves it alive | **HIGH** | C2 with explicit tests |
| R3 | Aliasing Chat secret to Core value hides a rotation bug | **HIGH** | Delete the indirection (C1/C10) |
| R4 | Extension UID change forces embed re-activation | **MEDIUM** | Only one dev store affected today **[L]** |
| R5 | Losing independent Chat uninstall | **MEDIUM** | Product acceptance |
| R6 | Losing standalone App Store listing | **MEDIUM** | Commercial acceptance |
| R7 | Core prod and dev share one client id **[R]** | **MEDIUM** | D4 |
| R8 | Extension deploy coupled to Core release cadence | **LOW** | Accept |

---

## 19. Complexity estimate

| Workstream | Complexity | Estimate |
|---|---|---|
| Repository changes (C1–C11) | **HIGH**, driven by C2 and C11 | 5–8 engineer-days |
| Shopify Partner/Dashboard (D1–D6) | **MEDIUM** | 0.5–1 day + review latency **[?]** |
| Data migration | **LOW** | < 0.5 day (1 dev row) |
| QA | **MEDIUM** | 2–3 days |
| Production rollout | **CRITICAL** to execute, small in size | 0.5 day + monitoring |
| **Total** | | **8–13 engineer-days** |

Compare with the cost of *not* unifying: creating and maintaining a second production app, a second secret, a second OAuth lifecycle, a second uninstall path, a second dashboard configuration, and a permanent merchant-facing double install.

---

## 20. Recommendation and GO / NO-GO

**Recommendation: Option B - one Core Shopify app with optional Chat activation.**

Reasoning against the criteria requested:

- **Merchant experience:** one install instead of two, one authorization, chat becomes a toggle in Channels. Strictly better.
- **Technical risk:** concentrated in one CRITICAL item (C11/R1) with a mechanical mitigation and a test that proves it.
- **Security:** neutral to slightly positive. The claimed structural isolation is already policy-level because product reads use the Core token **[R]**.
- **Maintainability:** removes an entire app identity, secret, OAuth flow, token column and 4 webhook handlers.
- **Deployment safety:** *worse before better.* The repo TOML becomes authoritative for Core. This is the one thing that must be engineered, not assumed.
- **Existing installations:** effectively zero cost **now** - no production Chat app, one dev install **[R/L]**.
- **Future App Store strategy:** the only real casualty. If Chat is ever to be listed standalone, this decision must be revisited, and that is a commercial call.

**VERDICT: GO**, conditional on the four blockers below.

**Blockers before any implementation:**

1. **B1 [CRITICAL]** `shopify.app.production.toml` must carry Core's exact 16 scopes and real redirect URLs, verified against `connectors-admin.ts`, before any `shopify app deploy` runs. Alternative: set `include_config_on_deploy = false` and manage Core config in the dashboard only.
2. **B2 [CRITICAL]** `verify-chat-app-identity.mjs` must be inverted (it currently *forbids* the target architecture at line 130) and extended to assert the scope list.
3. **B3 [HIGH]** Explicit product acceptance that uninstalling Core also removes the storefront widget.
4. **B4 [MEDIUM]** Confirm live **[?]**: Core's existing app-proxy configuration, whether Core prod/dev are one app, and Shopify's actual behaviour on extension re-registration.

---

## Appendix: what this audit changed

Nothing. No code was modified, no Shopify CLI command that creates, links, configures or deploys was run, no Partner or Dev Dashboard object was touched, no production environment variable was altered, nothing was deployed, and `.omc/state` was not intentionally modified.

One pre-existing uncommitted edit from the **previous** task remains in the working tree and is disclosed here rather than silently reverted: `shopify-app/shopify.app.toml` has `name`/`handle` changed to `GOTCHA Chat Production` / `gotcha-chat-production`. Under the recommendation above that file should be reverted or replaced by `shopify.app.production.toml`.

---

## 21. Approved decision and live scope evidence (2026-08-04, update)

The product decision is settled: **Option B**, using the **existing GOTCHA app** rather than a new one. This section records evidence gathered after the original audit, some of which corrects it.

### 21.1 App identity

| Property | Value | Confidence |
|---|---|---|
| Client ID | `b1ce3aa50d8d2e67b978918629bc5f76` | **[R]** `SHOPIFY_API_KEY` |
| Used by Core OAuth? | Yes | **[R]** `connectors-admin.ts` |
| App name "GOTCHA" | **UNVERIFIED** | **[?]** no Admin API maps client ID to app name; dashboard not touched |
| Prod vs dev | **Same client ID in `.env` and `.env.prod`** | **[R]** |

The last row corrects audit risk **R7** from "possible" to **confirmed**: there is no Core Dev app. Every config deploy would hit production and development at once.

### 21.2 The 25 scopes are already granted

Read live via `GET /admin/oauth/access_scopes.json` against the newest stored token **[L]**. Shopify returned **19 explicit** scopes in its canonical collapsed form, where a granted `write_X` implies `read_X`. Expanding the six implied reads gives **exactly the 25 requested scopes - none missing, none extra**.

The target scope set is therefore **proven valid and already approved for this app**. No scope in the list is invalid, deprecated or rejected.

**Caveat that matters:** this grant is on a **development store**. Development stores do not require Protected Customer Data review. It is evidence of scope *validity*, **not** of production PCD approval (blocker B2).

### 21.3 The OAuth code is vestigial

`connectors-admin.ts` requests **15** scopes **[R]**; the app granted **25** **[L]**. The grant comes from app-level configuration (Shopify managed installation), not from the authorize URL's `scope` parameter.

This is good news for unification: the app config is already the source of truth, which is exactly the model the unified design needs. It also means the code's scope list is misleading and should be reconciled or removed.

It also reverses a documented decision: the code comments say draft-order scopes are *"Deliberately NOT requested... no draft-order tool exists"* **[R]**, yet `read_draft_orders` is granted and is in the approved 25.

### 21.4 Existing installations are not uniform

| Tenant | Token expiry | Effective scopes | Classification |
|---|---|---|---|
| `cms4ug98n…` | 2026-08-03 | **25/25** | FULLY GRANTED |
| `cms4tcrb9…` | 2026-07-28 | 14/25 | REAUTHORIZATION REQUIRED |
| `cms4ayrz7…` | 2026-07-28 | 14/25 | REAUTHORIZATION REQUIRED |

All three tokens are **expired** (HTTP 401) but carry refresh tokens, so expiry needs no merchant action. The scope gap does.

**Direct consequence for work already merged:** the returns and exchanges feature added in `9c8d701` requires `write_returns` and `write_order_edits`, which the two older installs lack. On those tenants the Return and Exchange buttons will correctly report a missing scope rather than fail - the capability gate added in that commit is what makes this visible instead of silent.

### 21.5 A scope used by code is absent from the approved set

`update_order_fulfillment` requires `write_merchant_managed_fulfillment_orders` **[R]**, which is **not** among the 25. Either add it or retire the tool. Blocker B3.

### 21.6 `grantedScopes` is never recorded

`TenantIntegration.config.grantedScopes` is **null on every row** **[L]**, which is why this audit had to query Shopify directly. `commerce-context.service.ts` reads that field to decide which buttons to show, so with it empty the code falls back to "assume granted" - the branch `granted.length === 0 || granted.includes(...)` **[R]**. Recording real granted scopes at OAuth time is a prerequisite for managing reauthorization at scale, and for the capability gates to be honest.

### 21.7 Effect on the original recommendation

Unchanged in direction, strengthened in confidence. The scope-isolation argument for a separate Chat app was already void (Chat declares `scopes = ""`); it is now clear the unified app **already holds every scope the product needs**. The remaining risk is entirely on the deploy path, and §5 of the runbook mitigates it by starting with `include_config_on_deploy = false`.
