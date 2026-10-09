# GOTCHA Frontend

The Customer Operations OS frontend. Next.js 16 (App Router), React 19,
TypeScript strict.

This is a clean-room implementation. Nothing here derives from any previous
GOTCHA interface.

---

## Requirements

Node 22 LTS (`.nvmrc` pins the exact version; `package.json` enforces
`>=20.9.0`, which Next 16 requires).

## Getting started

```bash
cp .env.example .env.local     # then fill in the values marked REPLACE_*
npm install
npm run dev                    # http://localhost:3000
```

To sign in against the dev backend you need an Authentik client registered with
redirect URI `http://localhost:3000/api/auth/callback`, and its id and secret in
`OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET`. Everything else in `.env.local` is
already pointed at dev. Generate a session key with `openssl rand -base64 48`.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm start` | Serve the production build |
| `npm run verify` | typecheck → lint → stylelint → format check → unit tests |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint, including architectural boundaries |
| `npm run lint:css` | Stylelint, including the logical-property rule |
| `npm run format` | Prettier, write |
| `npm run test` | Unit and component tests (Vitest) |
| `npm run test:e2e` | End-to-end tests (Playwright, LTR and RTL) |
| `npm run api:probe` | Print the shape of live API responses - see below |

---

## Architecture

Layers, and the direction dependencies may flow. This is **enforced** by
`eslint-plugin-boundaries`, not merely documented - a violation fails
`npm run lint`.

```
app/            routes only; thin, delegates immediately
  ↓
shell/          application frame, navigation, providers
  ↓
features/       feature slices (empty; product pages land here)
  ↓
domain/         domain models and the action lifecycle
  ↓
api/            transport, contracts, endpoint registry
  ↓
config/         validated environment

design-system/  primitives, patterns, tokens - depends on nothing above it,
                and deliberately not on i18n or api: primitives take already
                translated strings as props
```

Cross-cutting, each with a single owner: `auth/`, `tenant/`, `permissions/`,
`realtime/`, `server-state/`, `i18n/`, `observability/`, `forms/`.

### Where things live

| Concern | Location |
|---|---|
| Environment configuration | `src/config/env.server.ts`, `env.client.ts` |
| HTTP transport, error taxonomy | `src/api/client/` |
| **Every API URL** | `src/api/endpoints/registry.ts` |
| Response contracts | `src/api/contracts/` |
| OIDC + encrypted session cookie | `src/auth/` |
| BFF proxy to the platform | `src/app/api/bff/[...path]/route.ts` |
| Capability model | `src/permissions/capability.ts` |
| Locale registry (the only file to touch to add a language) | `src/i18n/locales.ts` |
| Design tokens | `src/design-system/tokens/tokens.css` |
| Content-Security-Policy | `src/observability/content-security-policy.ts`, issued per request by `src/proxy.ts` |
| Channel abstraction | `src/domain/channels/channel.ts` |
| Form architecture | `src/forms/use-app-form.ts` |
| URL / navigation state | `src/url-state/` |
| Region error containment | `src/design-system/patterns/ErrorBoundary.tsx` |
| URL safety at the render boundary | `src/lib/safe-url.ts` |

---

## Working agreements

These are enforced, not aspirational:

- **No `fetch` in UI code.** Lint error in `design-system/`, `shell/` and
  `features/`. Everything goes through `src/api`.
- **No `console`.** Lint error. Use `@/observability/logger`, which redacts and
  feeds Sentry breadcrumbs.
- **No physical CSS properties.** Stylelint error. Use `margin-inline`,
  `inset-inline-start`, `border-inline-end`. (`overflow-y` is the one
  documented exception - see `.stylelintrc.md`.)
- **No hardcoded user-facing strings.** Every string is a translation key.
- **No `any`.** Lint error.
- **No arbitrary visual values.** Colours, spacing, radii, motion and z-index
  come from tokens.
- **No shadows and no gradients.** The design says so explicitly: "one radius
  family, no shadows, no gradients". There is no elevation scale to reach for.
  Depth is surface colour and radius.
- **Frame vs panel.** `--frame-*` is the dark chrome, `--panel-*` is the light
  work surface. Text on the frame uses `tone="inherit"`; `--text-primary` is
  the panel's ink and renders invisible on the frame.
- **No `if (channel === 'whatsapp')`.** Ask `supports(channel, 'canReact')`.
  See `src/domain/channels/channel.ts`.
- **No unvalidated URL in `href` or `src`.** Provider and customer URLs go
  through `safeLinkUrl` / `safeMediaUrl` first.
- **No navigation state in `useState`.** Selected record, filters, search,
  page, tab and date range belong in the URL - that is what makes a view
  deep-linkable, refresh-survivable and shareable. Use `useUrlState`.
- **No direct Sentry import outside `observability/`.** Call
  `reportError(error, context)`; the sink is registered once at startup.

### Content-Security-Policy

The policy is nonce-based and issued fresh per request. Scripts are authorised
by nonce plus `strict-dynamic` - never `unsafe-inline`, which would be close to
having no script policy at all. `unsafe-eval` is permitted in development only,
for the Turbopack runtime.

Any inline `<script>` you add must carry the nonce, read in a Server Component
from the `x-nonce` request header. Without it the browser blocks the script -
which is the policy working, not a bug.

---

## The API contract situation

The platform's OpenAPI document declares **no response schemas** - every
success is typed `EnvelopeUnknown`, and the specification says so explicitly.
Schemas in `src/api/contracts/` marked `@unverified` are structural minimums
written to be tolerant, not a published contract.

To tighten one from evidence rather than guesswork:

```bash
API_BASE_URL=https://dev.gotcha.co.il \
GOTCHA_ACCESS_TOKEN=<token> \
npm run api:probe
```

It prints keys and types only - never values - so its output is safe to paste
into a ticket.

Read `docs/api-gaps.md` before building any product page. It records what is
missing, what was worked around and how, and what is deliberately left inert.

## Building a product page

1. Understand the UX requirement.
2. List the data and actions each component needs.
3. Check the API contracts for them.
4. Map backend capability to frontend domain operations.
5. **Report gaps before inventing workarounds** - add to `docs/api-gaps.md`.
6. Implement only once the contract is understood.

No mock data, no manufactured state, no unrelated endpoints pressed into
service.
