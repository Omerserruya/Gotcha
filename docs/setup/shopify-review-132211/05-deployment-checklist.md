# Deployment checklist

> **There is no customer to lock out.** An earlier draft of this file called
> the single connected store a blocker. A read-only classification via the
> server-side state path showed it is our own development store with a
> cancelled subscription, so switching it off after deployment is the CORRECT
> behaviour, not an incident. The preparation below is now verification, not
> remediation.

## 0. Production as classified (read-only, 2026-09-28)

Both Shopify connections belong to **one tenant**, `cmssrazgl…1r4z`, whose
GOTCHA Core plan is `poc`.

| Fact | Value |
|------|-------|
| Connected store | `shining-face-drgeqqoi.myshopify.com` — Shopify's auto-generated development-store name shape |
| Second connection | `activewaer.myshopify.com` — **uninstalled** 2026-09-15 |
| Shopify state (server-side path) | `CANCELLED`, reason `provider_status_cancelled` |
| Cancelled at | 2026-09-17 |
| Reported plan handle | `gotcha-connector` — **known**, matches the configured catalog |
| `grantsAccess` | `false` |
| Entitlements | `[]` |
| `lastVerifiedAt` | 2026-09-28 (reconciliation is running and current) |
| Grandfather grants | 0 |
| Tenants with any Shopify entitlement | **0** |

**Why there are no `SHOPIFY_SUBSCRIPTION` rows.** The subscription was
cancelled on 2026-09-17 and `revokeShopifyEntitlements` deletes exactly those
rows on a confirmed cancellation. The system behaved correctly. The plan handle
is known, so this is not `UNKNOWN_PLAN`; reconciliation ran today and Shopify's
own answer is still "cancelled", so there is nothing to reconcile either.

**Therefore no grandfather grant is appropriate.** Of the five conditions a
grant requires, this store fails the first two outright: it is not a real
customer store, and there was no external paid GOTCHA relationship before
publication — the tenant is on a `poc` plan. Tenant creation date is not
evidence of a paid relationship and is not used as such here.

**Do not create a grant. Do not set a cutoff. Do not change the grandfather
flags.** None of it is needed.

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

## 2. Before deploying `ai` — verify, do not remediate

The enforcement is fail-closed, so this step exists to confirm that nothing
legitimate is caught by it. As classified above, nothing is.

- [ ] **Re-run the classification immediately before deploying.** It can change:
      a real merchant could connect and subscribe between now and then. The
      check is "every CONNECTED Shopify store either holds a
      `SHOPIFY_SUBSCRIPTION` row or is a store we are content to switch off".
- [ ] **If a real customer store has appeared**, stop and decide deliberately:
      have them subscribe through Shopify (preferred — the plan handle is known
      and the catalog is correct), or, only if all five grandfather conditions
      are genuinely met, create an auditable grant. That is a production
      decision and is out of scope for this work.
- [ ] **Expect the development store to lose Shopify access.** That is the
      change working. Do not treat it as a regression or roll back for it.

## 3. Deployment order

1. **Build and stage images** for `ai`, `conversation`, `billing`, `gateway`
   at the release SHA. Build for **arm64** — the box is aarch64 and the publish
   script defaults to amd64.
2. **Deploy `billing` and `conversation` first.** VERIFIED, not assumed:
   `conversation` gates only on `FEATURES.AUTO_BUY`, which is not a Shopify
   feature, and `billing` has no Shopify `isEntitled` call site. Neither
   activates any part of the Shopify veto, so this is a safe warm-up that
   proves the shared package builds and boots.
3. **Deploy `gateway`** (the Billing UI). Safe to deploy early: showing the two
   subscriptions is honest regardless of enforcement state, and it does not
   grant or remove anything. With the store cancelled, the Billing page will
   correctly read "Connector cancelled" before `ai` is touched.
4. **Deploy `ai` LAST.** This is the moment enforcement becomes real. Do it only
   after §2 passes.
5. **No restarts beyond the recreated containers.** cloudflared reaches the
   gateway on published `localhost:80`, so the tunnel is untouched.

Use the gateway-only recipe already documented in the deploy notes:
`--no-deps`, a per-command `TAG=`, and `--pull never`.

## 4. Smoke tests after deploying `ai`

- [ ] A tenant **with** a verified Connector: Shopify products load, Inbox order
      context renders, a Shopify tool appears to an agent. **Note: no such
      tenant exists in production today**, so this can only be exercised by
      subscribing a store — see the unprovable list in
      `07-policy-evidence-matrix.md`.
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
