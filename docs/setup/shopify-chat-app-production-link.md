# Linking the GOTCHA Chat app to the production Partner app

**Status: NOT DONE.** The production Shopify Chat app has never been created or
linked. Everything else in the Shopify chat path is built and tested; this is
the one remaining step, and it cannot be automated because it needs an
interactive browser login to your Shopify Partner account.

Run `node scripts/shopify/verify-chat-app-identity.mjs` at any time to see the
current state. Today it refuses, and says why:

```
linked client id   (unset)
expected chat id   (unset)
core client id     …5f76  ← must differ

✗ REFUSING TO PROCEED
  • Manifest has no client_id — the CLI project is not linked.
  • SHOPIFY_CHAT_APP_CLIENT_ID is not set (looked in .env.prod and the environment).
```

---

## Why this is dangerous enough to need a checklist

`shopify.app.toml` uploads its configuration on deploy. If the CLI is linked to
the **Core** Shopify integration app (`SHOPIFY_API_KEY`, id ending `5f76`)
instead of the Chat app, a deploy REPLACES Core's scopes and redirect
allowlist. That would strip `read_orders` / `write_orders` / `read_customers` /
`read_returns` / price-rule scopes from **every connected store** and break
their OAuth. There is no undo.

`verify-chat-app-identity.mjs` exists to make that mistake impossible. Run it
before every `shopify app` command. It refuses when the linked id is missing,
equals Core's, or disagrees with `SHOPIFY_CHAT_APP_CLIENT_ID`.

---

## Steps

These need your Partner-account browser session, so you run them.

### 1. Install the CLI

```bash
npm install -g @shopify/cli@latest
```

Not added to the repo: it is a developer tool, not a runtime dependency, and
the no-new-dependencies rule applies to the workspaces.

### 2. Create the production app in the Partner dashboard

In the Partner dashboard, create a new app named **GOTCHA Chat**, handle
`gotcha-chat`. Create it as a NEW app; do not reuse the Core integration and do
not reuse `GOTCHA Chat (Dev)` (`96c9417a…`), which is bound to
`dev.gotcha.co.il` and must stay that way.

### 3. Link the CLI project to it

```bash
cd shopify-app
shopify app config link          # choose GOTCHA Chat — NOT the Core app, NOT Dev
```

This writes `client_id` into `shopify.app.toml`.

> `config link` rewrites the file with Shopify's defaults. Afterwards, re-check
> that these still hold, because the CLI will have changed them:
> `embedded = false`, `application_url` and the redirect URL on
> `app.gotcha.co.il`, `scopes = ""`, and the `[app_proxy]` block. The comments
> in the file explain why each value is what it is.

### 4. Put the identity in `.env.prod`

Both keys are currently present but EMPTY:

```bash
SHOPIFY_CHAT_APP_CLIENT_ID=<the client id config link just wrote>
SHOPIFY_CHAT_APP_SECRET=<the app's client secret from the Partner dashboard>
```

`SHOPIFY_CHAT_APP_SECRET` is what verifies the app-proxy signature and the
webhook HMACs. Without it, every storefront proxy call and every webhook is
refused at runtime, which looks exactly like a broken widget.

### 5. Verify BEFORE deploying

```bash
node scripts/shopify/verify-chat-app-identity.mjs
```

Must print `✓` and a `linked client id` that differs from `core client id`.
If it refuses, stop; do not pass it with `--force`, there is no such flag on
purpose.

### 6. Deploy the app + theme extension

```bash
cd shopify-app
shopify app deploy
```

### 7. Tell me when it is done

I will then run, against the live app:

- `node scripts/shopify/verify-chat-app-identity.mjs` (identity + config drift)
- `node scripts/shopify/verify-storefront-widget.mjs` (widget actually serves)
- `node scripts/shopify/dev-e2e.mjs` (end-to-end conversation through the proxy)

and report what passes and what does not.

---

## Notes

- **`app.gotcha.co.il` must resolve and serve before step 6.** The manifest
  points the app proxy, the OAuth callback and all four webhooks at it. A
  previous round recorded this host as NXDOMAIN; confirm it is live first, or
  Shopify will sign requests that arrive nowhere.
- **The Chat app requests no scopes, by design.** Product truth comes from the
  Core integration's existing `read_products` grant through a server-side
  projection, and Add to Cart happens in the shopper's own browser. Requesting
  a scope nothing consumes is what App Store review rejects.
- **Returns need no new Core scope.** `read_returns`, `write_returns` and
  `write_order_edits` are already in the Core connector's requested set
  (`services/ai/src/routes/connectors-admin.ts`). Stores connected BEFORE those
  were added hold an older grant and must reconnect; the commerce panel reports
  that honestly as a missing scope rather than showing a button that fails.
