# Webhook migration matrix

Every inbound webhook endpoint, derived from the route definitions. A webhook is
**not** an OAuth redirect: it is a delivery destination with retries, signatures
and at-least-once semantics behind it. Migrating one wrongly does not produce a
login error — it silently drops events, and the gap is only visible later.

Paths below are verified against source:

```
services/ai/src/index.ts:138             app.use("/api", shopifyWebhookRoutes)
services/ai/src/routes/shopify-webhooks.ts:348  router.use("/shopify-chat/webhooks", chat)
services/ai/src/routes/shopify-webhooks.ts:349  router.use("/connectors/shopify/webhooks", core)
```

## Shopify Chat app

Registered in `shopify-app/shopify.app.toml`. That file's own comment is the
important part:

> **this file only takes effect when the app is deployed to the Partner
> dashboard. Changing it here does not change the live subscription.**

| Topic | Path | Old | New | Signature | Raw body |
|---|---|---|---|---|---|
| `app/uninstalled` | `/api/shopify-chat/webhooks/app-uninstalled` | marketing host | `https://app.gotcha.co.il/...` | HMAC, **Chat secret** | required |
| `customers/data_request` | `/api/shopify-chat/webhooks/customers-data-request` | marketing host | `https://app.gotcha.co.il/...` | HMAC, Chat secret | required |
| `customers/redact` | `/api/shopify-chat/webhooks/customers-redact` | marketing host | `https://app.gotcha.co.il/...` | HMAC, Chat secret | required |
| `shop/redact` | `/api/shopify-chat/webhooks/shop-redact` | marketing host | `https://app.gotcha.co.il/...` | HMAC, Chat secret | required |
| App proxy | `/api/shopify-chat/proxy` | marketing host | `https://app.gotcha.co.il/api/shopify-chat/proxy` | Shopify `signature` | n/a |

The app proxy is **not** a webhook and must not be treated as one. It is how the
storefront proves which customer is chatting: the shopper's browser calls the
merchant's own origin, and Shopify then calls this URL server-to-server with
`logged_in_customer_id` and a signature. `url` must match the manifest host or
Shopify signs a request that arrives nowhere.

## Shopify Core app — separate Partner app, separate secret

| Topic | Path | New |
|---|---|---|
| `app/uninstalled` | `/api/connectors/shopify/webhooks/app-uninstalled` | `https://app.gotcha.co.il/...` |
| `customers/data_request` | `/api/connectors/shopify/webhooks/customers-data-request` | `https://app.gotcha.co.il/...` |
| `customers/redact` | `/api/connectors/shopify/webhooks/customers-redact` | `https://app.gotcha.co.il/...` |
| `shop/redact` | `/api/connectors/shopify/webhooks/shop-redact` | `https://app.gotcha.co.il/...` |

Core and Chat verify with **different secrets**. Registering a Core topic
against a Chat URL produces an HMAC failure that looks like an attack in the
logs and is actually a configuration error.

## Meta — WhatsApp, Messenger, Instagram

| Purpose | Path | Method | Notes |
|---|---|---|---|
| Verification challenge | `/api/webhook` | GET | Must echo `hub.challenge`; Meta will not save the URL otherwise |
| Inbound delivery | `/api/webhook` | POST | `X-Hub-Signature-256`, raw body required |

One URL serves WhatsApp, Messenger and Instagram; the payload identifies the
product. Meta permits **one callback URL per product per app**, so this is an
immediate replacement, not a dual registration — the changeover is atomic and
must be verified within the same maintenance window.

## Billing

| Provider | Path | Signature |
|---|---|---|
| iCount | `/api/billing/webhooks/icount` | provider scheme |
| Stripe | see Stripe dashboard (`docs/setup/marketplace-oauth-setup-guide.md`) | `Stripe-Signature`, raw body |

Stripe permits **multiple endpoints**, each with its **own signing secret**. If
a second endpoint is created for the new host, store its secret separately and
accept both during the migration. Deduplicate by Stripe event ID. Do not rotate
the existing secret — it is unrelated to the hostname.

## Channel and other inbound

| Provider | Path |
|---|---|
| Generic inbound | `/api/webhook/` |
| Email | `/api/webhook/email` |
| Gmail | `/api/webhook/gmail` |
| Outlook | `/api/webhook/outlook` |
| Slack | `/api/webhook/slack` |
| Voice inbound | `/api/voice/incoming/voice` |

The voice endpoint was displayed to operators as
`https://gotcha.co.il/api/voice/incoming/voice`. The marketing host does not
serve `/api/`, so any operator who followed that screen configured their
telephony provider to deliver calls nowhere. It now derives from the application
origin.

## Strategy per provider

Not every provider can be migrated the same way, and choosing wrongly loses
events.

| Provider | Strategy | Why |
|---|---|---|
| Shopify Chat | **dual registration** | `include_config_on_deploy = true` replaces the allow-list; both hosts must be present across the switch |
| Shopify Core | dual registration | same mechanism, separate app |
| Meta | **immediate replacement** | one callback URL per product; no dual registration is possible |
| Stripe | **parallel endpoint** | multiple endpoints supported, each with its own secret |
| iCount | verify with provider | capability unknown from the repository |
| Voice | immediate replacement | operator-configured per channel |

## What must not break

- **Signature validation.** Every provider signs the raw body. Any proxy or
  Cloudflare rule that rewrites, buffers or re-encodes a webhook body breaks
  HMAC verification for every provider at once.
- **Raw-body parsing.** JSON middleware that consumes the stream before the
  verifier runs produces the same failure.
- **Idempotency.** Old and new endpoints may both be live during the overlap.
  Deduplicate on the provider's event/webhook ID, not on arrival time.
- **Retries.** A provider retrying an event delivered before the switch may
  deliver it again after. Without deduplication, a mutation runs twice.
- **Uninstall and GDPR events.** These are the ones nobody notices missing.
  A dropped `app/uninstalled` leaves a stale installation; a dropped
  `customers/redact` is a compliance failure with a deadline attached.

## Cloudflare

Provider webhooks must not be subject to browser-oriented protection. A managed
challenge or bot check on a webhook path returns HTML to a provider expecting
`200`, which the provider records as a failure and eventually disables the
subscription. Exempt every path in this document from bot protection, and
disable caching on all of them.
