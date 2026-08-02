# OAuth redirect matrix

Every OAuth redirect URI the application owns. Paths are **derived from the
route definitions**, not invented — the source file and mount prefix are given
so each can be checked.

A redirect URI is not a webhook. It is validated against an allow-list the
provider holds, and the provider rejects anything not on it. See
[`webhook-migration-matrix.md`](./webhook-migration-matrix.md) for delivery
endpoints.

## How a redirect URI is resolved

Each provider reads its **own fully-qualified environment variable**. There is
no shared prefix that can be changed once — every variable below must be set
individually.

```
services/ai/src/routes/connectors-admin.ts:340   process.env.STRIPE_REDIRECT_URI
services/ai/src/routes/connectors-admin.ts:410   process.env.HUBSPOT_REDIRECT_URI
services/ai/src/routes/connectors-admin.ts:519   process.env.SHOPIFY_REDIRECT_URI
```

The OIDC login callback is the exception: it is **derived** from `APP_ORIGIN` as
`<APP_ORIGIN>/api/auth/callback`, overridable with `OIDC_SERVER_REDIRECT_URI`
(`.env.example`).

## Identity (Authentik)

| Field | Old | New | Env var | Dashboard | Multiple allowed |
|---|---|---|---|---|---|
| OIDC issuer | `https://auth.gotcha.co.il/application/o/gotcha/` | unchanged | `OIDC_ISSUER`, `NEXT_PUBLIC_OIDC_ISSUER` | Authentik → Providers | n/a |
| Browser redirect URI | `http://localhost:3000/auth/callback` (dev), `https://app.gotcha.co.il/auth/callback` (prod) | `https://app.gotcha.co.il/auth/callback` | `NEXT_PUBLIC_OIDC_REDIRECT_URI` | Authentik → Provider → Redirect URIs | yes |
| Backend callback | derived `<APP_ORIGIN>/api/auth/callback` | `https://app.gotcha.co.il/api/auth/callback` | `APP_ORIGIN` / `OIDC_SERVER_REDIRECT_URI` | Authentik → Provider → Redirect URIs | yes |
| Post-logout | see checklist | `https://app.gotcha.co.il/login` | Authentik | Authentik → Provider | yes |

> `NEXT_PUBLIC_OIDC_REDIRECT_URI` is **baked into the static bundle at build
> time**. Changing it requires a gateway image rebuild. See the rollout
> checklist.

## Marketplace connectors — `services/ai/src/routes/connectors-admin.ts`

Mounted under `/api`, so the full path is `/api/connectors/<slug>/oauth/callback`.

| Provider | Route (source line) | Old | New | Env var | Multiple allowed | Reconnect needed |
|---|---|---|---|---|---|---|
| Stripe | `:354` | `https://gotcha.co.il/api/connectors/stripe/oauth/callback` | `https://app.gotcha.co.il/api/connectors/stripe/oauth/callback` | `STRIPE_REDIRECT_URI` | yes | no |
| HubSpot | `:464` | `https://gotcha.co.il/api/connectors/hubspot/oauth/callback` | `https://app.gotcha.co.il/api/connectors/hubspot/oauth/callback` | `HUBSPOT_REDIRECT_URI` | yes | no |
| Shopify Core | `:590` | `https://gotcha.co.il/api/connectors/shopify/oauth/callback` | `https://app.gotcha.co.il/api/connectors/shopify/oauth/callback` | `SHOPIFY_REDIRECT_URI` | yes | **yes** |
| Shopify Chat | `:134` | `https://gotcha.co.il/api/connectors/shopify-chat/oauth/callback` | `https://app.gotcha.co.il/api/connectors/shopify-chat/oauth/callback` | `SHOPIFY_CHAT_REDIRECT_URI` | yes, and **both must be listed during migration** | **yes** |
| Salesforce | `:1063` | marketing host | `https://app.gotcha.co.il/api/connectors/salesforce/oauth/callback` | `SALESFORCE_REDIRECT_URI` | yes | no |
| Monday | `:1143` | marketing host | `https://app.gotcha.co.il/api/connectors/monday/oauth/callback` | `MONDAY_REDIRECT_URI` | yes | no |
| Airtable | `:723` | marketing host | `https://app.gotcha.co.il/api/connectors/airtable/oauth/callback` | `AIRTABLE_REDIRECT_URI` | **verify — Airtable PKCE apps are restrictive** | no |
| Wix | `:911` | marketing host | `https://app.gotcha.co.il/api/connectors/wix/oauth/callback` | — | verify | no |
| Square | `:987` | marketing host | `https://app.gotcha.co.il/api/connectors/square/oauth/callback` | — | verify | no |

## Integration connectors — `/api/integrations/...`

| Provider | Route | New value | Env var |
|---|---|---|---|
| Zoho CRM | `/oauth/zoho_crm/callback` | `https://app.gotcha.co.il/api/integrations/oauth/zoho_crm/callback` | `ZOHO_REDIRECT_URI` |
| Google Calendar | `/oauth/google-calendar/callback` | `https://app.gotcha.co.il/api/integrations/oauth/google-calendar/callback` | `GOOGLE_CALENDAR_REDIRECT_URI` |
| Calendly | `/oauth/calendly/callback` (`:221`) | `https://app.gotcha.co.il/api/integrations/oauth/calendly/callback` | `CALENDLY_REDIRECT_URI` |
| Google Drive | `/oauth/google-drive/callback` (`:134`) | `https://app.gotcha.co.il/api/integrations/oauth/google-drive/callback` | `GOOGLE_REDIRECT_URI` |
| Confluence | `/oauth/confluence/callback` (`:32`) | `https://app.gotcha.co.il/api/integrations/oauth/confluence/callback` | `CONFLUENCE_REDIRECT_URI` |

## Channels

| Provider | Route | New value | Env var |
|---|---|---|---|
| Gmail / Google channel | `/api/channels/oauth/callback` | `https://app.gotcha.co.il/api/channels/oauth/callback` | `GOOGLE_OAUTH_REDIRECT_URI` |
| Microsoft / Outlook | as documented in `docs/setup/outlook-channel-setup-guide.md` | `https://app.gotcha.co.il/api/channels/oauth/callback` | `MICROSOFT_OAUTH_REDIRECT_URI` |
| Slack | `docs/setup/slack-channel-setup-guide.md` | `https://app.gotcha.co.il/api/channels/oauth/callback` | `SLACK_OAUTH_REDIRECT_URI` |
| Instagram | — | `https://app.gotcha.co.il/api/channels/oauth/callback` | `INSTAGRAM_OAUTH_REDIRECT_URI` |

## Providers requiring particular care

**Google Cloud Console** allows multiple authorised redirect URIs, so old and
new can coexist through the migration. Changes can take minutes to propagate.

**Airtable** uses OAuth2 + PKCE and is stricter about redirect registration than
most. Verify whether a second URI can be added before removing the first, and if
not, treat it as an immediate replacement with a reconnect.

**Shopify Chat** is the one where getting this wrong is worst:
`include_config_on_deploy = true` makes a CLI deploy *replace* the redirect
allow-list wholesale. The manifest now lists both hosts for exactly this reason.

**Shopify Core and Shopify Chat are different Partner apps** with different
client IDs, secrets, scopes and callbacks. `scripts/shopify/verify-chat-app-identity.mjs`
exists to refuse a CLI command aimed at the wrong one. Do not merge their
configuration.

## Verification per provider

1. Start the connect flow from `https://app.gotcha.co.il`.
2. Confirm the provider's consent screen shows the **new** callback host.
3. Complete it and confirm the integration reaches `CONNECTED`.
4. Confirm the `state` parameter was validated (a mismatch must refuse, not warn).
5. Confirm the post-connect landing page is on `app.gotcha.co.il`.
6. Execute one read through the connection to prove the credential works.
