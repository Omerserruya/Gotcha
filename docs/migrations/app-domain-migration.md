# App domain migration — `app.gotcha.co.il`

Status: **prepared, not executed.** No production dashboard was touched and
nothing was deployed. This document and its four companions are the plan and the
operator's field-by-field checklist.

- [`oauth-redirect-matrix.md`](./oauth-redirect-matrix.md)
- [`webhook-migration-matrix.md`](./webhook-migration-matrix.md)
- [`external-dashboard-checklist.md`](./external-dashboard-checklist.md)
- [`domain-rollout-checklist.md`](./domain-rollout-checklist.md)
- [`../help-center/help-center-domain-audit.md`](../help-center/help-center-domain-audit.md)

## Canonical responsibilities

| Host | Owns | Must never serve |
|---|---|---|
| `gotcha.co.il` | marketing pages only | `/api/`, OAuth callbacks, webhooks |
| `app.gotcha.co.il` | authenticated app, its API, OAuth callbacks, webhooks | Authentik flows |
| `auth.gotcha.co.il` | Authentik only — login, logout, MFA, reset, verification | GOTCHA business callbacks, tenant pages |
| `help.gotcha.co.il` | Help Center | anything authenticated |
| `voice.gotcha.co.il` | voice service | application OAuth or generic webhooks |

## What was actually wrong

This was not a stale-string problem. The marketing hostname was **serving
application traffic**, and three of those were live customer-facing defects
rather than documentation drift.

| # | Where | What it did |
|---|---|---|
| 1 | `shopify-app/extensions/gotcha-chat/blocks/gotcha_chat.liquid` | The storefront widget loaded its **API and its JavaScript** from `https://gotcha.co.il`. This ships into merchant storefronts. |
| 2 | `frontend/src/app/help/HelpKit.tsx` | The **public** Help Center's login button pointed at `https://dev.gotcha.co.il/login` — every visitor who clicked it was sent to an environment they have no account on. |
| 3 | `frontend/src/app/settings/voice-channels/[id]/page.tsx` | Told operators to send inbound calls to `https://gotcha.co.il/api/voice/incoming/voice`. The marketing host does not serve `/api/`, so the failure appears as silence on a phone line. |
| 4 | `shopify-app/shopify.app.toml` | Production Shopify Chat manifest: app URL, OAuth callback, four compliance webhooks and the app proxy, all on the marketing host. |
| 5 | `docker-compose.prod.yml` | `SHOPIFY_CHAT_REDIRECT_URI` default on the marketing host. |
| 6 | 23 lines across `docs/setup/` and `docs/architecture/` | Operator setup guides instructing people to register marketing-host callbacks in provider dashboards. |

### The quieter one

Twenty call sites built customer-facing links as:

```ts
process.env.FRONTEND_URL || "http://localhost:3000"
```

With `FRONTEND_URL` unset in production, tenant invitations, password-created
links, approval links and notification deep links all point at **localhost**.
Nothing throws and nothing logs; the first person to discover it is a customer
who cannot open the link they were sent. `services/auth/src/routes/onboarding.ts`
had a different fallback — `https://gotcha.co.il` — sending an authenticated
user to the marketing site.

## The fix

### One URL layer

`packages/shared/src/lib/app-urls.ts`. Five surfaces, each with a canonical
variable, the legacy variables it supersedes, and a development-only default:

| Surface | Canonical var | Legacy read | Required in prod |
|---|---|---|---|
| app | `PUBLIC_APP_URL` | `APP_ORIGIN`, `APP_PUBLIC_URL`, `FRONTEND_URL` | yes |
| marketing | `PUBLIC_MARKETING_URL` | — | no |
| auth | `PUBLIC_AUTH_URL` | `AUTHENTIK_URL` | yes |
| help | `PUBLIC_HELP_URL` | — | no |
| voice | `PUBLIC_VOICE_URL` | `VOICE_PUBLIC_URL` | no |

Legacy variables are **read, not duplicated**, so one deployment cannot disagree
with itself about where the application lives.

Four properties, each chosen against a specific failure:

- **A missing value is fatal in production.** Never a localhost fallback. Even
  the optional surfaces refuse to emit a dev default in production, because a
  help link to localhost in a customer email is still a broken link.
- **The origin is never caller-supplied.** Every helper takes a path. There is
  no input through which a request body can change the hostname, which is what
  stops a `returnTo` becoming an open redirect carrying our brand.
- **Marketing and application are separate functions.** Sending an authenticated
  user to the marketing site has to be something somebody typed.
- **`oauthRedirectUri()` and `webhookUrl()` are distinct** even though both
  currently resolve to the app origin. A redirect URI is validated against an
  allow-list the provider holds; a webhook URL is a delivery destination with
  retries and signatures behind it. Conflating them is how a domain migration
  drops events.

### A guard that keeps it

`scripts/check-domains.mjs`, wired as `npm run check:domains`.

It does **not** grep for `gotcha.co.il` — that hostname is still valid and in
daily use, so a plain grep is noise nobody would act on. It checks the thing
that is actually wrong: the **marketing host carrying an application path**
(`/api/`, `/auth/callback`, `/cb`, `/settings`, `/ai-studio`, `/inbox`), plus
non-production hostnames committed outside dev-only config, plus `http://`
against any of our hosts.

`localhost` and fixtures are deliberately not flagged. A check that fires on
every local default gets suppressed, and a suppressed check protects nothing.

It found **36 violations**. All are now resolved or explicitly allowlisted with
a stated reason.

## Deliberate compatibility

| Item | Why it stays | Remove when |
|---|---|---|
| `shopify.app.toml` lists **both** callback hosts | `include_config_on_deploy = true` makes a deploy *replace* the redirect allowlist. Shipping only the new URL breaks the OAuth of any merchant mid-install. | observation period passes with no callbacks arriving on the marketing host |
| `gotcha_chat.liquid` theme-editor help text names the dev host | It is the instruction for merchants testing against dev. The shipped default is `app.gotcha.co.il`. | never — this is correct |
| `scripts/shopify/*.mjs` target the dev storefront | Pointing screenshot tooling at production would photograph a live merchant. | never — this is correct |

## Constraint the rollout must respect

`.env.example:78` — **`NEXT_PUBLIC_*` are frozen into the static bundle at
gateway build time** (`scripts/docker-publish.sh`), not read at runtime.
Changing `NEXT_PUBLIC_OIDC_REDIRECT_URI` or `NEXT_PUBLIC_API_URL` requires
rebuilding and pushing a new gateway image. Setting the environment variable
alone changes nothing, and the symptom is a login loop against a redirect URI
the provider will reject.

## Cookies

Already correct and worth not breaking: the session cookie is
`__Host-gotcha_session` — host-only, `Secure`, `HttpOnly`, `SameSite=Lax`,
`Path=/`, **no `Domain`**. The `__Host-` prefix makes host-only scoping a
browser-enforced property rather than a convention.

One item needs a decision: `.env.example:76` documents
`AUTHENTIK_COOKIE_DOMAIN=gotcha.co.il`, a **parent-domain** cookie readable by
every subdomain. See [`external-dashboard-checklist.md`](./external-dashboard-checklist.md)
for the question that has to be answered before this migration, not after.

## What is not done here

- Nothing deployed, nothing merged, no external dashboard modified.
- Provider dashboards hold the authoritative allow-lists. Repository changes
  are inert until an operator performs the steps in the checklist.
- Cloudflare hostname routing is not represented in this repository at all
  (`gateway/nginx.prod.conf.template` is `server_name _`, a catch-all), so the
  hostname → service mapping must be verified in the Cloudflare dashboard.
