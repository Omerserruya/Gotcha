# External dashboard checklist

Every manual action, by dashboard, with exact values. **Nothing in this file has
been performed.** Repository changes are inert until these are done.

Legend — **Coexist**: can old and new values both be present during migration?

---

## 0. Decide this first

`.env.example:76` documents `AUTHENTIK_COOKIE_DOMAIN=gotcha.co.il` — a
**parent-domain** cookie, readable by `app.`, `help.`, `voice.` and any future
subdomain.

The GOTCHA session cookie is already host-only (`__Host-gotcha_session`, no
`Domain`), which is correct and should not change. The question is only whether
Authentik needs its cookie shared across subdomains.

- If SSO across subdomains is **not** required → set the Authentik cookie
  host-only to `auth.gotcha.co.il`. Adding subdomains widens a parent-domain
  cookie's blast radius, and this migration adds subdomains.
- If it **is** required → keep the parent domain, and record why here.

Answer before migrating, not after. Changing cookie scope later invalidates
every live session.

---

## 1. Authentik — `https://auth.gotcha.co.il`

| Field | Location | Old | New | Coexist | Reconnect |
|---|---|---|---|---|---|
| Redirect URIs | Providers → OAuth2/OIDC → Redirect URIs | `https://dev.gotcha.co.il/...`, localhost | `https://app.gotcha.co.il/auth/callback` **and** `https://app.gotcha.co.il/api/auth/callback` | yes | no |
| Launch URL | Applications → GOTCHA | old app URL | `https://app.gotcha.co.il` | no | no |
| Post-logout redirect | Providers → OAuth2/OIDC | — | `https://app.gotcha.co.il/login` | yes | no |
| Cookie domain | System → Settings | `gotcha.co.il` | see §0 | no | invalidates sessions |
| WebAuthn RP ID | Flows → MFA/passkey stage | verify | must cover the origin users register from | **no — changing the RP ID invalidates existing passkeys** | yes, re-enrol |
| Email template links | Flows → Email stage | verify | password reset and verification must land on `app.gotcha.co.il` | yes | no |

Both `/auth/callback` (browser) and `/api/auth/callback` (backend) are required
— they are different clients in the same flow.

> **WebAuthn is the irreversible one.** A passkey is bound to the RP ID it was
> created under. If the RP ID changes, every enrolled passkey stops working and
> users must re-register. Verify the current value before touching anything.

**Verify:** login, logout, MFA challenge, password reset, email verification,
new-tenant invitation, passkey, expired session, cross-tab session, return to
the originally requested path.

---

## 2. Shopify — Core app (Partner Dashboard)

⚠️ Core and Chat are **different Partner apps**. Run
`node scripts/shopify/verify-chat-app-identity.mjs` before any CLI command.

| Field | Old | New | Coexist | Reconnect |
|---|---|---|---|---|
| App URL | marketing host | `https://app.gotcha.co.il` | no | no |
| Allowed redirection URL | `https://gotcha.co.il/api/connectors/shopify/oauth/callback` | `https://app.gotcha.co.il/api/connectors/shopify/oauth/callback` | **yes — add before removing** | **yes, per store** |
| `app/uninstalled` | marketing host | `https://app.gotcha.co.il/api/connectors/shopify/webhooks/app-uninstalled` | yes | — |
| `customers/data_request` | marketing host | `https://app.gotcha.co.il/api/connectors/shopify/webhooks/customers-data-request` | yes | — |
| `customers/redact` | marketing host | `https://app.gotcha.co.il/api/connectors/shopify/webhooks/customers-redact` | yes | — |
| `shop/redact` | marketing host | `https://app.gotcha.co.il/api/connectors/shopify/webhooks/shop-redact` | yes | — |

Every connected store must re-run OAuth. Per the Shopify readiness work,
**operator-disabled tools remain disabled after reconnect** — reconnecting
restores the tool surface, not the tenant's policy.

---

## 3. Shopify — Chat app (Partner Dashboard + CLI)

Source of truth: `shopify-app/shopify.app.toml`.

| Field | Old | New | Coexist |
|---|---|---|---|
| App URL | `https://gotcha.co.il/api/connectors/shopify-chat/oauth/init` | `https://app.gotcha.co.il/api/connectors/shopify-chat/oauth/init` | no |
| Allowed redirection URLs | marketing host | **both** app and marketing hosts | **yes — required** |
| `app/uninstalled` | marketing host | `https://app.gotcha.co.il/api/shopify-chat/webhooks/app-uninstalled` | yes |
| `customers/data_request` | marketing host | `https://app.gotcha.co.il/api/shopify-chat/webhooks/customers-data-request` | yes |
| `customers/redact` | marketing host | `https://app.gotcha.co.il/api/shopify-chat/webhooks/customers-redact` | yes |
| `shop/redact` | marketing host | `https://app.gotcha.co.il/api/shopify-chat/webhooks/shop-redact` | yes |
| App proxy URL | `https://gotcha.co.il/api/shopify-chat/proxy` | `https://app.gotcha.co.il/api/shopify-chat/proxy` | no |
| Scopes | `""` (empty by design) | **unchanged** | — |

`include_config_on_deploy = true` means `shopify app deploy` **replaces** scopes
and the redirect allow-list. Deploying with only the new URL breaks the OAuth of
any merchant mid-install; deploying against the Core app strips Core's scopes
from every connected store.

### Storefront extension

The theme block previously loaded its API **and its JavaScript** from
`https://gotcha.co.il`. It now defaults to `https://app.gotcha.co.il`, but the
old value is live in merchant themes until the extension version is deployed
**and each merchant's theme picks it up**.

- Keep `https://gotcha.co.il/widget/*` and the storefront API paths serving
  (redirect or proxy to the app host) until telemetry shows no traffic.
- A merchant who set `api_base`/`asset_base` manually keeps their override.

---

## 4. Meta — developers.facebook.com

| Field | Location | New | Coexist |
|---|---|---|---|
| App Domains | Settings → Basic | `gotcha.co.il`, `app.gotcha.co.il` | yes |
| Valid OAuth Redirect URIs | Facebook Login → Settings | `https://app.gotcha.co.il/api/channels/oauth/callback` | yes |
| WhatsApp callback URL | WhatsApp → Configuration | `https://app.gotcha.co.il/api/webhook` | **no — one per product** |
| Messenger callback URL | Messenger → Settings | `https://app.gotcha.co.il/api/webhook` | no |
| Instagram callback URL | Instagram → Settings | `https://app.gotcha.co.il/api/webhook` | no |
| Verify token | each product | unchanged | — |
| Deauthorize callback | Settings → Basic | **no such route exists in this repository** — see note below | — |
| Data deletion request URL | Settings → Basic | **no such route exists in this repository** — see note below | — |
| Privacy Policy URL | Settings → Basic | `https://gotcha.co.il/privacy-policy` (marketing — correct) | — |
| Terms URL | Settings → Basic | `https://gotcha.co.il/terms` (marketing — correct) | — |

> **Found during this audit, not caused by it.** Searching the repository for
> `deauthorize`, `data_deletion` and `deletion_request` returns nothing. There
> is no implemented handler for either. Whatever is currently registered in the
> Meta dashboard for these two fields points at something this codebase does not
> serve. That is a compliance gap independent of the domain move — Meta requires
> a working Data Deletion Request URL for apps handling user data — and it
> should be raised separately rather than papered over with a plausible-looking
> URL in this checklist. Do not enter a new value for these two fields until a
> route exists.

Meta re-verifies the callback on save: the GET challenge must echo
`hub.challenge` immediately or the URL will not save. Because only one callback
per product is possible, this is an atomic switch — do it in a window where
someone is watching delivery.

**Verify:** webhook verification, signed inbound, outbound send, template send,
media send, embedded signup, Messenger, Instagram, reconnect, deauthorization.

---

## 5. Stripe

| Field | Location | New | Coexist |
|---|---|---|---|
| Webhook endpoint | Developers → Webhooks | new endpoint on `app.gotcha.co.il` | **yes — add alongside** |
| Signing secret | per endpoint | **new endpoint has its own secret** | store both during migration |
| OAuth redirect | Connect → Settings | `https://app.gotcha.co.il/api/connectors/stripe/oauth/callback` | yes |
| Portal return URL | Billing → Customer portal | `https://app.gotcha.co.il/settings/billing` | no |
| Checkout success/cancel | code, not dashboard | `app.gotcha.co.il` via `PUBLIC_APP_URL` | — |

Do **not** rotate the existing webhook secret — it is unrelated to the hostname.
A new endpoint gets a new secret; accept both, deduplicate by event ID, and
remove the old endpoint after the observation period.

---

## 6. Google Cloud Console

| Field | New | Coexist |
|---|---|---|
| Authorised redirect URIs | `https://app.gotcha.co.il/api/integrations/oauth/google-drive/callback`, `https://app.gotcha.co.il/api/integrations/oauth/google-calendar/callback`, `https://app.gotcha.co.il/api/channels/oauth/callback` | yes |
| Authorised JavaScript origins | `https://app.gotcha.co.il` | yes |
| OAuth consent — homepage | `https://gotcha.co.il` | — |
| OAuth consent — privacy/terms | marketing URLs | — |

Changes can take several minutes to propagate. Add new URIs, wait, verify, then
remove old ones.

---

## 7. Other providers

| Provider | Field | New value | Coexist | Reconnect |
|---|---|---|---|---|
| HubSpot | Auth → Redirect URL | `https://app.gotcha.co.il/api/connectors/hubspot/oauth/callback` | yes | no |
| Salesforce | Connected App → Callback URL | `https://app.gotcha.co.il/api/connectors/salesforce/oauth/callback` | yes | no |
| Zoho | API console → Redirect URI | `https://app.gotcha.co.il/api/integrations/oauth/zoho_crm/callback` | verify | possibly |
| Airtable | OAuth integration → Redirect URI | `https://app.gotcha.co.il/api/connectors/airtable/oauth/callback` | **verify — PKCE apps are restrictive** | possibly |
| Monday | App → OAuth redirect | `https://app.gotcha.co.il/api/connectors/monday/oauth/callback` | yes | no |
| Calendly | OAuth app | `https://app.gotcha.co.il/api/integrations/oauth/calendly/callback` | verify | no |
| Confluence/Atlassian | OAuth 2.0 → Callback URL | `https://app.gotcha.co.il/api/integrations/oauth/confluence/callback` | yes | no |
| Slack | OAuth & Permissions → Redirect URLs | `https://app.gotcha.co.il/api/channels/oauth/callback` | yes | no |
| Microsoft/Outlook | Entra → Redirect URIs | `https://app.gotcha.co.il/api/channels/oauth/callback` | yes | no |
| Wix | App → Redirect URL | `https://app.gotcha.co.il/api/connectors/wix/oauth/callback` | verify | no |
| Square | App → Redirect URL | `https://app.gotcha.co.il/api/connectors/square/oauth/callback` | verify | no |
| iCount | webhook + return URL | `https://app.gotcha.co.il/api/billing/webhooks/icount` | verify | no |
| ReturnGO | **no OAuth/webhook found in this repository** — verify with the provider before assuming none | — | — |

---

## 8. Cloudflare / DNS / Tunnel

`gateway/nginx.prod.conf.template` uses `server_name _` — a catch-all. **No
hostname routing exists in this repository.** The hostname → service mapping
lives entirely in Cloudflare, so it must be verified there.

| Action | Detail |
|---|---|
| DNS | `app` → tunnel/origin, proxied |
| DNS | verify `gotcha.co.il`, `auth`, `help`, `voice` each resolve to the right service |
| Tunnel ingress | add `app.gotcha.co.il` → gateway |
| SSL | Full (strict) |
| Cache | bypass for `/api/*`, `/auth/*`, `/cb`, and every webhook path |
| WAF | **exempt every webhook path from bot protection** — a challenge returns HTML to a provider expecting 200, and providers disable subscriptions that keep failing |
| Redirect rule | `gotcha.co.il/app/*` → `app.gotcha.co.il/*`, **302 during migration** |
| Redirect rule | old login paths → `app.gotcha.co.il/login`, 302 |
| **Do not redirect** | webhook POST paths — a redirect loses the body and the signature |
| WebSocket | enabled for `app.gotcha.co.il` |

Use 302 until the observation period ends. A 301 is cached by browsers and
intermediaries and is effectively irreversible.

---

## 9. Environment variables

| Variable | Value |
|---|---|
| `PUBLIC_APP_URL` | `https://app.gotcha.co.il` |
| `PUBLIC_MARKETING_URL` | `https://gotcha.co.il` |
| `PUBLIC_AUTH_URL` | `https://auth.gotcha.co.il` |
| `PUBLIC_HELP_URL` | `https://help.gotcha.co.il` |
| `PUBLIC_VOICE_URL` | `https://voice.gotcha.co.il` |
| `APP_ORIGIN` | `https://app.gotcha.co.il` |
| `AUTH_ALLOWED_ORIGINS` | `https://app.gotcha.co.il` |
| `APP_PUBLIC_URL` | `https://app.gotcha.co.il` |
| `APP_PUBLIC_URL_ALLOWED_HOSTS` | `app.gotcha.co.il` |
| `FRONTEND_URL` | `https://app.gotcha.co.il` (legacy, still read) |
| every `*_REDIRECT_URI` | per the OAuth matrix |

**`NEXT_PUBLIC_*` require a gateway image rebuild** — they are frozen into the
static bundle at build time (`.env.example:78`). Setting them at runtime changes
nothing, and the symptom is a login loop.
