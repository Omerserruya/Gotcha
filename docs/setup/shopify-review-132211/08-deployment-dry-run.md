# Deployment dry-run — expected before/after, without changing anything

Produced read-only on 2026-09-28. Nothing was deployed, reconciled or granted.

## 1. Per-store transition

Both connections belong to one tenant (`cmssrazgl…1r4z`, Core plan `poc`).

| | `shining-face-drgeqqoi.myshopify.com` | `activewaer.myshopify.com` |
|---|---|---|
| Connection status | `CONNECTED` | `BILLING_PENDING`, uninstalled 2026-09-15 |
| Classification | Development / review store | Test store, removed |
| **Current effective Shopify entitlements** | **none** (`entitlements: []`) | none |
| Shopify state (server path) | `CANCELLED` | `CANCELLED` (same tenant subscription) |
| **After billing reconciliation** | **no change** — reconciliation ran 2026-09-28 and Shopify still reports cancelled; there is nothing active to reconcile | no change |
| **After `ai` enforcement deploys** | Shopify reads/writes/sync/storefront **denied** | already unreachable (uninstalled) |
| **Access remains available?** | **No — and that is correct.** The subscription is cancelled | No |
| **Remediation required before deploying `ai`** | **None.** Do not grant, do not set a cutoff | None |

**Today's behaviour vs after deploy.** Today the entitlements are already empty,
but nothing reads them, so the store still has full Shopify access. After the
deploy the empty entitlement set is finally honoured. The store loses access
**because its subscription was cancelled eleven days ago**, which is the whole
point of the change.

## 2. GOTCHA Core for that tenant — unaffected

| Capability | Before | After |
|---|---|---|
| Core plan `poc` | ACTIVE | ACTIVE |
| WhatsApp / Instagram / email / voice / web chat | working | working |
| Inbox, approvals, analytics, automations | working | working |
| Manual knowledge, WooCommerce and other non-Shopify integrations | working | working |
| `OVERRIDE` (1) and `TRIAL` (46) entitlement rows | present | **untouched** — the guard only ever reads Shopify-sourced rows |

## 3. Which deployed services carry the modified shared code

`packages/shared` is baked into every service image, so every rebuilt service
*contains* the new code. Whether it *activates* anything is a different
question, and it was checked rather than assumed:

| Service | Contains new shared code | Activates Shopify enforcement | Why |
|---|---|---|---|
| `ai` | yes | **YES — this is the one** | Gates on `FEATURES.SHOPIFY_LIVE_CHAT` (×8) and `SHOPIFY_PRODUCT_MESSAGING` (×2); owns `loadConnection`, the tool surface, tool dispatch, Inbox commerce context, catalogue, returns |
| `conversation` | yes | no | Its only `requireFeature` / `isFeatureEnabledForTenant` call is `FEATURES.AUTO_BUY`, which is not a Shopify feature, so `isShopifyFeature()` is false and the path is unchanged |
| `billing` | yes | no | No Shopify `isEntitled` call site. Grant and revoke logic is unchanged by this branch |
| `gateway` | static only | no | nginx plus the rebuilt `frontend/out`; it renders state, it does not decide it |
| all other services | yes | no | None gates on a Shopify feature |

**So rebuilding `conversation`, `billing` or `gateway` cannot switch enforcement
on early.** Only `ai` can.

## 4. Mixed old/new versions

**Compatible.** There is no schema change and no wire-format change:

- The guard reads `tenant_entitlements` rows that already exist, with columns
  that already exist.
- Old services reading entitlements see exactly the same rows; they simply do
  not apply the Shopify source rule.
- No inter-service contract changed. `ai` does not ask another service for an
  authorization verdict — it reads the entitlement itself.

The only observable difference in a mixed fleet is **which service enforces
Shopify**, and during the staged rollout that is deliberately "none until `ai`".

## 5. Can the staged deployment leave inconsistent state?

**No persistent inconsistency.** Nothing in this branch writes state; the guard
is a pure read. The transient window is: the Billing UI (in `gateway`) reports
the authoritative Shopify state before `ai` enforces it.

For the current data that window is **honest, not misleading** — the store is
cancelled, so the UI already says "Connector cancelled / Shopify features are
off" while `ai` is still permitting access. The UI leads the backend by a few
minutes and tells the truth about billing the whole time.

Were a store *active*, the same window would show "Connector active" while `ai`
had not yet started enforcing — also harmless, since it would be permitting
access the subscription pays for.

## 6. Can reconciliation run safely before `ai` is upgraded?

**Yes, and it is the right order.** Reconciliation writes
`SHOPIFY_SUBSCRIPTION` rows through the existing, unchanged grant path. Old
`ai` ignores those rows; new `ai` reads them. Running it first means the
entitlements are already correct at the moment enforcement begins, rather than
racing it.

## 7. Does the production catalog carry all four entitlement keys?

**Yes.** `SHOPIFY_BILLING_PLAN_CATALOG` in production defines one plan, handle
`gotcha-connector`, granting exactly:

```
shopify_catalog_sync, shopify_order_read, shopify_order_actions, shopify_storefront_widget
```

That handle matches the `planHandle` the server-side state path reports for
this tenant, so a future subscription on this plan would grant the full set and
would **not** land in `UNKNOWN_PLAN`.

## 8. Residual risks

1. **No production tenant has ever held a Shopify entitlement**, so the "happy
   path with enforcement on" has never been observed anywhere. The first real
   subscription is also the first real test.
2. The classification is a point-in-time read. **Re-run it immediately before
   deploying `ai`.**
3. Development-store status is inferred from the shop-name shape and the `poc`
   plan, not from a stored flag — `isDevelopmentStore` is evaluated at install
   time for the grandfather decision and is not persisted on the connection. A
   live Partner API shop query would settle it definitively if anyone wants
   that certainty before deploying.
