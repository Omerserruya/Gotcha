# Deployment checklist

> **Read the blocker first.** The new enforcement is fail-closed, and as of the
> measurement below **nobody in production holds a Shopify entitlement**.
> Deploying without the preparation in §2 switches Shopify off for every
> connected store.

## 0. Production as measured (read-only, 2026-09-28)

| Fact | Value |
|------|-------|
| Shopify commerce connections | 2 (1 `CONNECTED`) |
| Connected Shopify integrations | 1 |
| **Tenants holding any Shopify-funded entitlement** | **0** |
| Tenants total | 8 |
| `SHOPIFY_BILLING_ENABLED` | `true` |
| `SHOPIFY_BILLING_MODE` | `app_pricing` |
| `SHOPIFY_BILLING_ENV` | `test` (not live) |
| `SHOPIFY_ALLOW_GRANDFATHERED` | `false` |
| `SHOPIFY_APP_PUBLICATION_CUTOFF` | **empty** |
| `SHOPIFY_ALLOW_SPLIT_BILLING` | `true` |

Two consequences, both blocking:

1. **One live store loses Shopify access the moment this deploys.** It has a
   connection but no entitlement, and the guard reads entitlements only.
2. **Grandfathering cannot currently rescue it.** `SHOPIFY_ALLOW_GRANDFATHERED`
   is `false` *and* the cutoff is empty, and a missing cutoff grandfathers
   nobody by design.

## 1. What ships

| Item | Value |
|------|-------|
| Branch | `fix/shopify-review-132211-split-billing` |
| Commits | `38c79ea4`, `7bf8c018`, `51dcd96a`, `2dae9623` |
| Paths changed | `packages/shared`, `services/ai`, `frontend/src` |
| **Migrations** | **None.** `EntitlementSource` already carries `SHOPIFY_SUBSCRIPTION` and `SHOPIFY_GRANDFATHERED`; `TenantEntitlement` already carries `fundedByBillingSource` and `expiresAt`. |

**Services to rebuild.** `packages/shared` is baked into every service image, so
rebuild all of them for consistency. Behaviour actually changes in:

- **`ai`** — the enforcement lives here (`loadConnection`, tool surface, tool
  dispatch, Inbox commerce context, live chat, catalogue, returns).
- **`conversation`** — calls `requireFeature` / `isFeatureEnabledForTenant`, so
  it inherits the Shopify veto.
- **`billing`** — calls `isEntitled`; grant/revoke behaviour is unchanged but
  the shared code beneath it moved.
- **`gateway`** — carries the rebuilt `frontend/out` (the Billing UI).

## 2. Before enforcement goes live — do these first

Do **not** deploy `ai` until every legitimate existing Shopify tenant is either
verified through Shopify Billing or holds a valid grandfather grant.

- [ ] **Identify the affected tenants.** One connected store today; re-run the
      count immediately before deploying, because it can change.
- [ ] **Decide per tenant:** are they a genuine pre-publication customer, or
      should they subscribe through Shopify?
- [ ] **For anyone staying on a grant:** set `SHOPIFY_APP_PUBLICATION_CUTOFF`
      to the real publication date and `SHOPIFY_ALLOW_GRANDFATHERED=true`, then
      create the grant and **verify the row exists** before deploying `ai`.
      A grant is a recorded `SHOPIFY_GRANDFATHERED` entitlement, never a flag.
- [ ] **For anyone subscribing:** have them approve the Connector, then confirm
      `SHOPIFY_SUBSCRIPTION` rows exist for them.
- [ ] **Re-run the entitlement count and require it to be non-zero** and to
      cover every connected store. This is the gate; if it fails, stop.

> Creating grants and changing these variables is a production change and is
> explicitly **out of scope for this work**. It is listed here because
> enforcement must not be deployed before someone does it deliberately.

## 3. Deployment order

1. **Build and stage images** for `ai`, `conversation`, `billing`, `gateway`
   at the release SHA. Build for **arm64** — the box is aarch64 and the publish
   script defaults to amd64.
2. **Deploy `billing` and `conversation` first.** Neither enforces anything new
   on its own, so this is a safe warm-up that proves the shared package builds
   and boots.
3. **Deploy `gateway`** (the Billing UI). Safe to deploy early: showing the two
   subscriptions is honest regardless of enforcement state, and it does not
   grant or remove anything.
4. **Deploy `ai` LAST.** This is the moment enforcement becomes real. Do it only
   after §2 passes.
5. **No restarts beyond the recreated containers.** cloudflared reaches the
   gateway on published `localhost:80`, so the tunnel is untouched.

Use the gateway-only recipe already documented in the deploy notes:
`--no-deps`, a per-command `TAG=`, and `--pull never`.

## 4. Smoke tests after deploying `ai`

- [ ] A tenant **with** a verified Connector: Shopify products load, Inbox order
      context renders, a Shopify tool appears to an agent.
- [ ] A tenant **without**: Shopify features are off, and **WhatsApp, Instagram,
      email, the Inbox, approvals and WooCommerce all still work.** This is the
      one that proves Core was not collaterally damaged.
- [ ] Billing page shows both sections with the right biller on each.
- [ ] Shopify integration page agrees with the Billing page.
- [ ] Logs: `shopify access denied for tenant …` lines appear only for tenants
      you expect, and carry **no token, shop domain or subscription id**.
- [ ] No 500s from `services/ai` around Shopify routes; a lapsed Connector must
      read as a normal denial, not a fault.

## 5. Rollback

| | |
|---|---|
| Roll back | `ai` first, then `gateway` |
| Rollback tag | the currently-running `ai` and `gateway` image tags — **capture them before deploying** (`docker inspect --format '{{.Config.Image}}'` per container) |
| Database | **Nothing to undo.** No migration ran. |

**Additive database state should REMAIN after a rollback.** Any
`SHOPIFY_SUBSCRIPTION` or `SHOPIFY_GRANDFATHERED` rows created during the
rollout are records of what Shopify confirmed or what an operator decided. The
old code simply does not read them, so leaving them costs nothing and deleting
them would destroy the evidence that makes a second attempt safe.

## 6. Known, accepted

- `SHOPIFY_BILLING_ENV` is `test`, so no live money moves yet. Going live is a
  separate, deliberate change requiring `SHOPIFY_ALLOW_LIVE_BILLING`.
- The code comment claiming Shopify has not confirmed split billing is stale;
  Shopify has confirmed it. The comment is corrected in this branch. **The
  configuration default is deliberately left alone** — `SHOPIFY_ALLOW_SPLIT_BILLING`
  is already `true` in production, and changing defaults is not part of this work.
