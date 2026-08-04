# Unified GOTCHA Shopify app — production runbook

**Date:** 2026-08-04
**Decision:** one production Shopify app (the existing **GOTCHA** app) owns OAuth, the Admin token, the 26-scope set, webhooks, the app proxy **and** the Chat Theme App Extension. Chat becomes a channel toggle inside GOTCHA, with no second OAuth.
**Status of this document:** planning only. **Nothing was deployed, no Shopify app was modified, no CLI create/link/deploy command was run.**

Evidence marks: **[R]** repository · **[L]** live (dev DB / Shopify Admin API read) · **[I]** inferred · **[?]** requires Partner Dashboard verification.

---

## 1. Confirmed GOTCHA app identity

| Property | Value | Confidence |
|---|---|---|
| Client ID | `b1ce3aa50d8d2e67b978918629bc5f76` | **[R]** `.env.prod` / `.env`, key `SHOPIFY_API_KEY` |
| App name | **GOTCHA** (confirmed by the app owner). A LABEL, not the identity check | **[R]** |
| Organization | account `omer.serruya@gotcha.co.il` | **[L]** CLI account cache |
| App type / distribution | public app, Partner-distributed | **[I]** |
| Production application URL | **[?]** dashboard-managed; no Core TOML exists in the repo | **[R]** absence |
| Production redirect URL | `https://app.gotcha.co.il/api/connectors/shopify/oauth/callback` | **[R]** `.env.prod` |
| Development redirect URL | `https://dev.gotcha.co.il/api/connectors/shopify/oauth/callback` | **[R]** `.env` |
| Declared scopes | see §2 — **the app grants more than the OAuth code requests** | **[L]** |
| Protected Customer Data status | **[?]** — a dev-store grant is not proof of production approval |
| Installed stores (dev DB) | 3 tenant rows, all `urban-supply-gotcha-demo.myshopify.com` | **[L]** |
| Installed stores (production) | **[?]** — production DB not read by this audit |
| Is this the app Core OAuth uses? | **Yes.** `connectors-admin.ts` builds the authorize URL from `SHOPIFY_API_KEY` | **[R]** |

### Critical identity finding

**`SHOPIFY_API_KEY` is byte-identical in `.env` and `.env.prod` (`…5f76`) [R].** Production and development Core installs are the **same Shopify app**. There is no separate Core Dev app today. Any config deploy therefore hits production and development simultaneously.

### Identity is the client id

The name was supplied by the app owner and is recorded above, but it is **not** the identity assertion: names are editable and non-unique. The verifier keys on `client_id === b1ce3aa50d8d2e67b978918629bc5f76`, which is what Shopify itself keys the app on and the only value that cannot be true of two different apps.

The app **handle** is deliberately absent. This app is backend-driven rather than an embedded App Home, so nothing in the deployment path consumes it, and a guessed handle only produces admin deep links that 404 for the merchant. Add it only if pulled directly from Shopify.

---

## 2. Exact scope list

### Requested target set (26, authoritative per the approved decision)

```
read_all_orders                              read_inventory_transfers
read_assigned_fulfillment_orders             read_merchant_managed_fulfillment_orders
read_customers                               write_order_edits
write_customers                              read_order_edits
read_price_rules                             read_orders
write_price_rules                            write_orders
read_discounts                               read_product_feeds
write_discounts                              read_product_listings
read_draft_orders                            read_products
read_fulfillments                            read_returns
read_inventory                               write_returns
read_inventory_shipments                     read_third_party_fulfillment_orders
read_inventory_shipments_received_items       write_merchant_managed_fulfillment_orders
```

### What the app ACTUALLY granted, read from Shopify

Read live from the newest installation's token via `GET /admin/oauth/access_scopes.json` **[L]**:

```
read_all_orders, read_assigned_fulfillment_orders, write_customers,
write_price_rules, write_discounts, read_draft_orders, read_fulfillments,
read_inventory, read_inventory_shipments, read_inventory_shipments_received_items,
read_inventory_transfers, read_merchant_managed_fulfillment_orders,
write_order_edits, write_orders, read_product_feeds, read_product_listings,
read_products, write_returns, read_third_party_fulfillment_orders
```

19 explicit. Shopify returns the **canonical collapsed form**: a granted `write_X` implies `read_X` and the read is not listed separately. Expanding the six implied reads (`read_customers`, `read_price_rules`, `read_discounts`, `read_order_edits`, `read_orders`, `read_returns`) yields **25 of the 26 requested scopes**.

**This is the strongest evidence in this document.** The set is not aspirational: Shopify has already issued 25 of the 26 to this app.

The one exception is **`write_merchant_managed_fulfillment_orders`**, which `update_order_fulfillment` requires and which the live app does **not** currently hold. Adding it is a scope EXPANSION requiring merchant consent at the next install. Pinned by a test (`shopify-scopes.test.ts`) so it cannot drift unnoticed.

### Third finding: the OAuth code is out of date

`connectors-admin.ts` requests only **15** scopes **[R]**. The app granted 25. The grant therefore comes from the **app-level configuration** (Shopify managed installation), not from the `scope` parameter in the authorize URL. Consequences:

- The app config is already authoritative for scopes; the code's list is vestigial and misleading.
- The code list omits eight scopes the app actually holds, and its comment states draft-order scopes are *"Deliberately NOT requested... no draft-order tool exists"* **[R]** — yet `read_draft_orders` is granted and is in the approved 25. That deliberate exclusion is being reversed and should be an explicit product decision, not a silent one.

---

## 3. App-level approval matrix

| Scope | Valid | Declared (app) | App approved | Existing stores granted | Special review | GOTCHA usage |
|---|---|---|---|---|---|---|
| `read_all_orders` | ✅ **[L]** | ✅ | ✅ **[L]** | newest ✅ / older ✅ | **YES — Shopify-gated** | orders >60 days; lifetime history, commerce facts |
| `read_customers` | ✅ | ✅ (implied) | ✅ | newest ✅ / older ✅ | **YES — PCD** | customer lookup, CRM projection |
| `write_customers` | ✅ | ✅ | ✅ | newest ✅ / older ✅ | **YES — PCD** | tags, notes, profile updates |
| `read_orders` | ✅ | ✅ (implied) | ✅ | newest ✅ / older ✅ | **YES — PCD** | order lookup |
| `write_orders` | ✅ | ✅ | ✅ | newest ✅ / older ✅ | — | cancel, refund, invoice, order note |
| `read_returns` | ✅ | ✅ (implied) | ✅ | newest ✅ / older ✅ | — | `get_returns` |
| `write_returns` | ✅ | ✅ | ✅ | newest ✅ / **older ❌** | — | `create_return` |
| `read_merchant_managed_fulfillment_orders` | ✅ | ✅ | ✅ | newest ✅ / **older ❌** | — | tracking, cancel preflight, returns |
| `read_assigned_fulfillment_orders` | ✅ | ✅ | ✅ | newest ✅ / **older ❌** | — | **unused in code** |
| `read_third_party_fulfillment_orders` | ✅ | ✅ | ✅ | newest ✅ / **older ❌** | — | **unused in code** |
| `read_fulfillments` | ✅ | ✅ | ✅ | newest ✅ / **older ❌** | — | **unused in code** |
| `read_inventory` | ✅ | ✅ | ✅ | newest ✅ / **older ❌** | — | `inventory_status`, `variant_information` |
| `read_inventory_shipments` | ✅ | ✅ | ✅ | newest ✅ / **older ❌** | — | **unused in code** |
| `read_inventory_shipments_received_items` | ✅ | ✅ | ✅ | newest ✅ / **older ❌** | — | **unused in code** |
| `read_inventory_transfers` | ✅ | ✅ | ✅ | newest ✅ / **older ❌** | — | **unused in code** |
| `write_order_edits` | ✅ | ✅ | ✅ | newest ✅ / **older ❌** | — | exchanges |
| `read_order_edits` | ✅ | ✅ (implied) | ✅ | newest ✅ / **older ❌** | — | exchanges |
| `read_price_rules` | ✅ | ✅ (implied) | ✅ | newest ✅ / older ✅ | — | `list_discounts`, `validate_discount` |
| `write_price_rules` | ✅ | ✅ | ✅ | newest ✅ / older ✅ | — | coupons, compensation |
| `read_discounts` | ✅ | ✅ (implied) | ✅ | newest ✅ / older ✅ | — | **unused in code** (code uses price rules) |
| `write_discounts` | ✅ | ✅ | ✅ | newest ✅ / older ✅ | — | **unused in code** |
| `read_draft_orders` | ✅ | ✅ | ✅ | newest ✅ / older ✅ | — | **unused in code**, explicitly excluded by a code comment |
| `read_products` | ✅ | ✅ | ✅ | newest ✅ / older ✅ | — | catalog, chat product cards |
| `read_product_feeds` | ✅ | ✅ | ✅ | newest ✅ / older ✅ | — | **unused in code** |
| `read_product_listings` | ✅ | ✅ | ✅ | newest ✅ / older ✅ | — | **unused in code** |

Every scope in the list is **VALID** — proven by Shopify having granted all 25 **[L]**. None are invalid or deprecated.

### Scope used by code but MISSING from the approved 25

| Scope | Used by | Impact |
|---|---|---|
| `write_merchant_managed_fulfillment_orders` | `update_order_fulfillment` **[R]** | **RESOLVED:** kept in the approved 26-set. Not yet in the live grant, so the tool cannot succeed until a merchant consents at next install. |

### Unused scopes flagged for review (not removed, per instruction)

`read_assigned_fulfillment_orders`, `read_third_party_fulfillment_orders`, `read_fulfillments`, `read_inventory_shipments`, `read_inventory_shipments_received_items`, `read_inventory_transfers`, `read_discounts`, `write_discounts`, `read_draft_orders`, `read_product_feeds`, `read_product_listings` — **11 of 25 have no code path today [R]**. They are harmless to hold but enlarge the consent screen and the PCD review surface.

---

## 4. Existing-installation grant matrix

Read live from each stored token **[L]**. No token value was printed, logged or transmitted anywhere.

| Tenant | Shop | Token expiry | Live probe | Effective scopes | Classification |
|---|---|---|---|---|---|
| `cms4ug98n0004chmrp4lv6ujl` | urban-supply-gotcha-demo | 2026-08-03 | HTTP 401 (expired) | **25/25** | **FULLY GRANTED** (token needs refresh only) |
| `cms4tcrb90008tpldh1vu2tbc` | urban-supply-gotcha-demo | 2026-07-28 | HTTP 401 (expired) | 14/25 | **REAUTHORIZATION REQUIRED** |
| `cms4ayrz700047h8pse45hvx8` | urban-supply-gotcha-demo | 2026-07-28 | HTTP 401 (expired) | 14/25 | **REAUTHORIZATION REQUIRED** |
| Production stores | — | — | not read | — | **UNKNOWN [?]** |

**Missing on both older installs (11):** `read_assigned_fulfillment_orders`, `read_fulfillments`, `read_inventory`, `read_inventory_shipments`, `read_inventory_shipments_received_items`, `read_inventory_transfers`, `read_merchant_managed_fulfillment_orders`, `write_order_edits`, `read_order_edits`, `write_returns`, `read_third_party_fulfillment_orders`.

### Two consequences worth stating plainly

1. **All three tokens are expired.** Every one carries a `refreshToken` and an `expiresAt` in the past **[L]**. Expiry alone needs **no merchant action** — the adapter's refresh grant handles it. This audit did **not** refresh them, because that mutates stored credentials.
2. **The returns and exchanges capability cannot work on the two older installs.** They lack `write_returns` and `write_order_edits`, which `create_return` and the exchange path require **[R]**. Scope expansion is a **merchant-consent action**: Shopify cannot silently widen an existing grant. The merchant must re-approve, which for a managed-install app happens on next open/update rather than through a full reconnect **[I, confirm in B4]**.

---

## 5. Production TOML values

Target file: **`shopify-app/shopify.app.production.toml`** (new). Do not reuse `shopify.app.toml`, which is structured as the Chat app.

> The pre-existing `name`/`handle` edit toward "GOTCHA Chat Production" has been **reverted**; `shopify.app.toml` is back to its committed state **[R]**.

```toml
client_id = "b1ce3aa50d8d2e67b978918629bc5f76"   # existing GOTCHA app — never change
name      = "GOTCHA"                              # [?] confirm exact name first (B1)
handle    = "<confirm in dashboard>"              # [?] B1
embedded  = false

application_url = "https://app.gotcha.co.il"

[access_scopes]
# EXACTLY the approved 25. Never abbreviate to the collapsed form Shopify
# returns - the config is a request, not a grant.
scopes = "read_all_orders,read_assigned_fulfillment_orders,read_customers,write_customers,read_price_rules,write_price_rules,read_discounts,write_discounts,read_draft_orders,read_fulfillments,read_inventory,read_inventory_shipments,read_inventory_shipments_received_items,read_inventory_transfers,read_merchant_managed_fulfillment_orders,write_order_edits,read_order_edits,read_orders,write_orders,read_product_feeds,read_product_listings,read_products,read_returns,write_returns,read_third_party_fulfillment_orders"

[auth]
redirect_urls = [
  "https://app.gotcha.co.il/api/connectors/shopify/oauth/callback",
  # [?] B1: enumerate EVERY redirect already on the live app before deploying.
  # include_config_on_deploy REPLACES this list; an omission breaks OAuth.
]

[webhooks]
api_version = "2026-07"

  [[webhooks.subscriptions]]
  topics = [ "app/uninstalled" ]
  uri = "https://app.gotcha.co.il/api/connectors/shopify/webhooks/app-uninstalled"

  [webhooks.privacy_compliance]
  customer_data_request_url = "https://app.gotcha.co.il/api/connectors/shopify/webhooks/customers-data-request"
  customer_deletion_url     = "https://app.gotcha.co.il/api/connectors/shopify/webhooks/customers-redact"
  shop_deletion_url         = "https://app.gotcha.co.il/api/connectors/shopify/webhooks/shop-redact"

[app_proxy]
url     = "https://app.gotcha.co.il/api/shopify-chat/proxy"
subpath = "gotcha-chat"
prefix  = "apps"

[build]
# Start FALSE. Flip to true only once the verifier passes and every value
# above is confirmed against the live app. With it true, a deploy REPLACES
# the live scope list and redirect allowlist for every connected store.
include_config_on_deploy = false
```

The Chat Theme App Extension moves under this app unchanged in content: `extensions/gotcha-chat/`, block `gotcha_chat.liquid`. Its `uid` will be reissued on registration under the new owner **[I, confirm in B4]**.

---

## 6. Verifier command

Replaces `scripts/shopify/verify-chat-app-identity.mjs`, whose central assertion is *"core client id ← must differ"* and which hard-fails when the linked ID equals Core **[R: line 130]**. That check forbids the approved architecture and must be inverted.

```bash
node scripts/shopify/verify-unified-app-identity.mjs --config shopify.app.production.toml
```

Fails closed unless **all** hold:

1. `client_id` == `b1ce3aa50d8d2e67b978918629bc5f76`
2. app name/handle matches the confirmed GOTCHA identity
3. `client_id` != `96c9417a8e0b8b7ea17b8c9bf7f4c3ad` (Chat Dev)
4. scope set is **exactly** the 25, compared as a **set** after expanding implied reads — order-insensitive, no extras, no omissions
5. `application_url` is `https://app.gotcha.co.il`
6. every redirect URL present on the live app is present in the config
7. app-proxy URL is the production proxy
8. no `localhost`
9. no `dev.gotcha.co.il`
10. all four webhook endpoints present
11. scope count did not shrink versus the live app
12. the `gotcha-chat` extension is present under this app

Prints a normalized summary, exits non-zero on any mismatch. **No `--force`, no bypass.**

---

## 7. Pre-deploy checklist

- [x] **B1** app name supplied (GOTCHA); handle dropped as a blocker; **live redirect list and app-proxy config still required before CONFIG deploy only**
- [ ] **B2** Protected Customer Data approval confirmed for **production**, not inferred from a dev-store grant
- [x] **B3** RESOLVED — `write_merchant_managed_fulfillment_orders` kept, `update_order_fulfillment` kept
- [ ] **B4** Shopify behaviour confirmed for extension re-registration and for scope expansion on existing installs
- [ ] Production installed-store count and their granted scopes established from the production database
- [ ] `shopify.app.production.toml` authored, verifier green
- [ ] `include_config_on_deploy` still `false` for the first deploy
- [ ] Rollback rehearsed on a Core **dev** app (which does not exist yet — see §10)

---

## 8. Deployment command — DO NOT EXECUTE YET

```bash
# Only after every box in §7 is ticked.
node scripts/shopify/verify-unified-app-identity.mjs --config shopify.app.production.toml \
  && cd shopify-app \
  && shopify app deploy --config production
```

**This command can replace the live scope list and redirect allowlist of the app every merchant is connected through.** It is written here for review, not for running.

---

## 9. Post-deploy verification

1. Re-read granted scopes for a known store and assert all 25 survive.
2. Assert the redirect allowlist still contains every previously working callback.
3. Complete one OAuth install on a scratch dev store; confirm 25 granted.
4. Confirm the app proxy answers `GET /apps/gotcha-chat/...` with a valid signature.
5. Confirm all four webhook endpoints receive and verify a test delivery.
6. Confirm the Chat App Embed appears in the Theme Editor under GOTCHA.
7. Confirm existing commerce tools still work for an already-connected store.

---

## 10. Reauthorization plan

| Population | Action | Merchant involvement |
|---|---|---|
| Expired-but-refreshable tokens (all 3 dev rows today) | adapter refresh grant | **None** |
| Installs missing scopes (2 dev rows, 11 scopes short) | scope expansion requires consent | **Yes** — re-approve |
| Production stores | **UNKNOWN [?]** — establish before rollout | TBD |

Do **not** auto-disconnect or auto-reconnect any store. Surface a "reconnect to enable returns and exchanges" prompt driven by a real granted-scope read, and record `grantedScopes` at OAuth time — it is currently **null for every row [L]**, which is why this audit had to ask Shopify directly. Fixing that is a prerequisite for managing this at scale.

---

## 11. Rollback plan

| Stage | Rollback |
|---|---|
| Before deploy | Delete the TOML. Nothing external changed |
| After deploy, scopes intact | Publish the previous app version in the Partner Dashboard |
| After deploy, scopes reduced | **Worst case.** Restore the scope list, re-publish, then every affected merchant must re-consent. Mitigated by `include_config_on_deploy = false` and by verifier check 11 |
| After extension move | Old extension remains under Chat Dev until explicitly removed; keep `…c3ad` alive until cutover is proven |
| After env var removal | Restore `SHOPIFY_CHAT_APP_*` and redeploy `ai` |

---

## Appendix — blockers

- ~~**B1**~~ RESOLVED for identity: name supplied, handle dropped as a blocker, client id is authoritative. Live redirect allowlist and app-proxy read-back remain required **before config deploy only**.
- **B2 [CRITICAL]** Confirm production Protected Customer Data approval for `read_customers` / `write_customers` / `read_orders` / `read_all_orders`. A dev-store grant does not prove it.
- ~~**B3**~~ RESOLVED: scope kept in the 26-set and the tool retained.
- **B4 [MEDIUM]** Confirm extension re-registration behaviour and scope-expansion mechanics for existing installs.
- **B5 [MEDIUM]** Core production and development share one client ID **[R]**. A Core Dev app is planned separately; until it exists, treat every Shopify CLI operation as production-sensitive.

---

## 12. Cutover deployment (added 2026-08-04)

### 12.1 Production environment variable changes

**REMOVE from `.env.prod`** (already removed from both compose files):

```
SHOPIFY_CHAT_APP_CLIENT_ID     # retired - identity is SHOPIFY_API_KEY
SHOPIFY_CHAT_APP_SECRET        # retired - signing is SHOPIFY_API_SECRET
```

Both are currently **empty** in `.env.prod`, so removing them changes no
running behaviour. They are deleted rather than pointed at the Core values:
two environment names for one secret means the first rotation that misses one
breaks app-proxy verification with an error that reads like a misconfigured
proxy.

**KEEP unchanged** (names only — values are not reproduced here):

| Variable | Note |
|---|---|
| `SHOPIFY_API_KEY` | the Core client id, recorded in §1 |
| `SHOPIFY_API_SECRET` | signs app-proxy requests and webhook HMACs |
| `SHOPIFY_REDIRECT_URI` | `https://app.gotcha.co.il/api/connectors/shopify/oauth/callback` |
| `SHOPIFY_CHAT_APP_URL`, `SHOPIFY_CHAT_REDIRECT_URI` | still name the asset host |
| `SHOPIFY_CHAT_EXTENSION_HANDLE`, `SHOPIFY_CHAT_BLOCK_HANDLE` | extension + App Embed block |

> Values are deliberately NOT written as `NAME=value` here. Secret scanning
> cannot tell a public client id from a live credential when both appear in
> that shape, and an allowlist entry for `SHOPIFY_API_KEY=` would teach the
> scanner to ignore the one line that might one day hold the real secret.
> The client id itself is in §1, in a table, where it reads as a fact rather
> than as something to paste into an environment.

**NOT required** (removed as deployment blockers): `SHOPIFY_APP_NAME`,
`SHOPIFY_APP_HANDLE`. The client id is the authoritative identity.

### 12.2 Services requiring rebuild

Only two. Verified by checking which services import the changed shared
modules (`shopify-app-identity`, `commerce-context.types`) - the answer is
`ai` alone:

| Service | Why |
|---|---|
| **`ai`** | Owns every changed route and service: proxy verification, webhooks, install/enable/disable, scope gating |
| **`gateway`** | Serves the static frontend bundle, which changed (API layer, settings component, deleted wizard) |

The other nine services bundle `packages/shared` too, but the only shared
change they see is an unused export. Rebuilding them is harmless and
unnecessary.

```bash
export REGISTRY=docker.io/omerserruya REPO=gotcha PLATFORM=linux/arm64
export TAG=$(git rev-parse --short HEAD)
SERVICES=ai,gateway ./scripts/docker-publish.sh
```

### 12.3 Extension-only Shopify deployment

**CANCELLED — no such thing exists.**

Shopify CLI 3.x removed `include_config_on_deploy`. Running `app deploy`
prints *"The `include_config_on_deploy` field is no longer supported and has
been removed from your configuration file"*, strips the field, and publishes
configuration and extensions **together**.

This was discovered by running the deploy on 2026-08-04 and reading the
prompt. The release was **cancelled at the confirmation step**; no version was
created. Any future deploy requires the live read-back in §12.5 first.

```bash
node scripts/shopify/verify-unified-app-identity.mjs   # must print ✓ and exit 0
cd shopify-app
shopify app deploy --config production
```

Preconditions, all currently true:

- production has **zero** Shopify installations (verified live)
- no protected customer data is accessed by an extension deploy
- `include_config_on_deploy = false` (asserted by a test)

### 12.4 Rollback

| Stage | Rollback |
|---|---|
| Repo only | `git revert` the branch; nothing external changed |
| After image push | Registry tags are immutable per SHA; redeploy the previous TAG |
| After service deploy | `sed -i "s/^TAG=.*/TAG=<previous>/" .env` then pull + `up -d` |
| After extension deploy | Publish the previous app version in the Partner Dashboard. Scopes and redirects were never touched, so nothing to restore there |
| Chat runtime | Restoring `SHOPIFY_CHAT_APP_*` requires reverting the code too - the variables are no longer read. Revert to the previous image rather than re-adding env vars |

Merchant connections and conversation history are unaffected by every row
above: no migration runs, and no destructive statement exists on either path.

### 12.5 Still blocked

| Item | Blocks | Status |
|---|---|---|
| Live redirect allowlist read-back | **Config deploy only** | Required before `include_config_on_deploy = true` |
| Live app proxy config read-back | **Config deploy only** | If the live app already has a different proxy, STOP and report before changing |
| Protected Customer Data approval | **Production merchant rollout** | Does not block repo work or an extension-only deploy while zero merchants are connected |
| `write_merchant_managed_fulfillment_orders` | `update_order_fulfillment` | In the 26-set but NOT in the live grant; needs consent at next install |


---

## 13. Live vs repository comparison (2026-08-04)

Live values supplied by the app owner after a Partner Dashboard read-back.
Nothing below is guessed.

| Setting | Live Dashboard | Repository TOML | Match | Planned change |
|---|---|---|---|---|
| App name | GOTCHA | GOTCHA | ✅ | none |
| Client ID | `b1ce3aa5…5f76` | `b1ce3aa5…5f76` | ✅ | none |
| Embedded | false | false | ✅ | none |
| Application URL | `https://gotcha.co.il` | `https://app.gotcha.co.il` | ❌ | **CHANGE — approved.** The app moved off the marketing apex; every OAuth, proxy and webhook endpoint resolves at `app.` |
| Redirect — app | released | present | ✅ | preserved |
| Redirect — apex | released | present | ✅ | **preserved deliberately** — not dropped despite the app URL move |
| Redirect — dev | released | present | ✅ | **preserved deliberately** |
| Webhook API version | 2026-04 | 2026-04 | ✅ | none — the repo's 2026-07 pin governs ADMIN calls, a separate contract |
| Access scopes | 25 effective | 26 | ❌ | **ADDITIVE ONLY.** `write_merchant_managed_fulfillment_orders` added; zero removed (proven by diff) |
| App proxy | **could not be read** | `/apps/gotcha-chat` → `https://app.gotcha.co.il/api/shopify-chat/proxy` | ? | **ADD.** See below |

### App proxy decision

The live proxy could not be read: `shopify app info` reports only local
config, and the only command that surfaces it is the deploy itself.

Proceeding with the intended proxy, on the authority given and because:

- there are **zero** Shopify production installations, so no merchant flow can break;
- the Chat runtime already expects exactly this path (`/api/shopify-chat/proxy`), verified in `shopify-chat-public.ts`;
- no repository code references any other proxy path — grepped;
- rollback is prepared (previous app version + previous image digests recorded).

If the released version turns out to have replaced a different live proxy,
that will be visible immediately after deploy and the previous app version can
be republished.

### Still blocked

**Protected Customer Data is in Draft, not approved.** This does not block
publishing configuration, publishing the extension, deploying services, or
development-store testing. It **does** block onboarding a real production
merchant, declaring protected customer/order functionality production-ready,
and processing protected production merchant data.
