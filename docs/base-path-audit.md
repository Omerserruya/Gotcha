# What assumes this app is mounted at the root

Written for the `/v2` deployment. Every item was checked against the code or a
build, not inferred — the ones marked **verified in the build** were confirmed
by inspecting `.next` after building with `NEXT_PUBLIC_BASE_PATH=/v2`.

## The rule that decides most of it

Next prefixes what it controls and nothing else:

| Prefixed automatically | Not prefixed |
| --- | --- |
| `next/link`, the router | `fetch()` |
| `redirect()` from `next/navigation` | `new URL()` |
| `source` in `headers()` / `redirects()` / `rewrites()` | `NextResponse.redirect()` |
| Sentry's `tunnelRoute` (it becomes a rewrite) | anything composed from a string |

**`fetch` and `new URL` are plain web APIs with no knowledge of a mount
point.** Every defect below is one of those two.

## Fixed

### 1 · The OIDC `redirect_uri` silently dropped the prefix

`new URL('/api/auth/callback', APP_ORIGIN)`. **An absolute path discards the
base's path**, with or without a trailing slash, so an `APP_ORIGIN` of
`https://host/v2` produced `https://host/api/auth/callback`.

This was the assumption I was asked to confirm, and it is false. Beside the
legacy product that URL is not a 404 — it is another application's route, and
the identity provider would have been registered against a redirect target this
app does not own. Either the flow fails on a mismatch, or it succeeds against
something else; the first is much the better outcome.

`appUrl` rebuilds the path from the mount point, so the result no longer depends
on whether whoever sets `APP_ORIGIN` includes the prefix. Same fix in
`post_logout_redirect_uri` and the sign-in redirect.

### 2 · The post-login landing, which fails only after a login that worked

`api/auth/callback` ends with `NextResponse.redirect(new URL(loginState.r,
APP_ORIGIN))`. `NextResponse.redirect` builds a raw `Response` and **does not
apply the base path** — unlike `redirect()` from `next/navigation`. So a
successful sign-in returned the user to the root with a valid v2 session.

The most invisible item in this list.

### 3 · Every client-side API call

`browser-api.ts` had `baseUrl: '/api/bff'`. Under a prefix, all of them go to
the root — carrying this app's session cookie, since it is scoped to `/`, to an
origin serving a different application.

### 4 · A second BFF caller that the first sweep missed

`features/home/use-agent-run.ts` builds an SSE URL as a template literal:
`` url: `/api/bff${…}` ``. A search for `fetch('/…')` does not find it. Found by
grepping the built client bundle for `api/bff` rather than the source.

### 5 · Sign-out and the realtime ticket

`fetch('/api/auth/logout')` and `fetch('/api/realtime/ticket')`, both from the
browser.

### 6 · The middleware's login redirect

`new URL('/api/auth/login', request.url)` — an absolute path again. Now built
from `request.nextUrl.basePath`, which is Next's own value, so it cannot
disagree with the build.

`returnTo` deliberately carries the **unprefixed** path: Next strips the prefix
from `nextUrl.pathname`, and the callback re-prefixes it with `appUrl`. Carrying
a prefixed path would produce `/v2/v2/…`.

### 7 · Sentry's tunnel route — and a double prefix I introduced

`tunnelRoute: '/monitoring'` is at the root, where the catch-all is the legacy
frontend. I first "fixed" it to `${basePath}/monitoring` and the built rewrite
came out **`/v2/v2/monitoring`**: `tunnelRoute` becomes a rewrite, and rewrite
sources are prefixed automatically. Reverted to the bare path.

**Verified in the build**: `/v2/monitoring(/?)` in `routes-manifest.json`.

## Correct already, checked anyway

- **The middleware matcher** `['/((?!api|_next|_vercel|.*\..*).*)']` matches
  against the path with the prefix already stripped, so the `api` exclusion
  still excludes `/v2/api/…`.
- **`headers()`** — **verified in the build**: `source` came out as
  `/v2/:path*`.
- **`next/image`** — the docs require the prefix in `src` by hand. There is no
  `next/image` usage in this codebase.
- **No sitemap, robots, manifest or `metadataBase`.**
- **`redirect('/api/auth/login')`** in the app layout — `redirect()` prefixes.

## Deliberate decisions, not defects

### The session cookie keeps `Path=/`

Narrowing it to the mount point would look tidier and buy nothing. What makes
the two apps independent is that they use **different cookie names** —
`gotcha_session` here, `__Host-gotcha_session` / `gotcha_session_dev` on the
platform — so a root-scoped cookie cannot collide with the legacy session.
Narrowing the path would add a way to lose a session on a path this app does not
control, in exchange for isolation the name already provides.

### The platform's `checkoutPath` is prefixed into this app

The 402 gate sends an in-app path (e.g. `/settings/billing/plan`) and
`TenantGateNotice` renders it through `Link`, so it gains the prefix and points
at **this** app's route. That is right while Omer is evaluating v2, and it is a
decision rather than a consequence: the platform means its own screen by that
path.

### `NEXT_PUBLIC_BASE_PATH` carries the public prefix on purpose

One variable, used by `next.config.ts` for `basePath` and by the browser for
`appPath`. Two earlier attempts to publish a private `APP_BASE_PATH` to the
client both failed **silently** — the `env:` config key did not reach the
replacement, and neither did assigning `process.env` inside the config. Each
time the bundle still contained a bare `"/api/bff"`.

A private name plus a public mirror is two variables that must agree, and the
disagreement fails in the worst way available: links prefixed, fetches not,
beside an application that answers the unprefixed paths.

**Verified in the build**: `appPath` compiles to ``function(e){return
`/v2${e}`}``.

## What the two apps genuinely share

The claim "they share nothing" needs one correction, and it is not about
frontend routes.

- **`/socket.io/`** — `realtime/socket-transport.ts` calls `io(REALTIME_URL)`,
  and `REALTIME_URL` is an **origin**, not an app path. That endpoint is the
  platform's realtime service. Both apps are clients of it exactly as both are
  clients of `/api/…`, so this is shared **backend**, by design, and prefixing
  it would point at `/v2/socket.io/`, which this app does not serve.
- The platform API itself, for the same reason.

What is *not* shared is any route this app serves. `/monitoring` was the one
exception and it now sits under the prefix.

**One fragility worth recording while we are here**: that socket is opened with
`transports: ['websocket']` and no polling fallback, deliberately, to halve
connect latency. If `/socket.io/` ever loses its upgrade headers, v2's realtime
fails outright where a polling client would degrade.

## Every `NEXT_PUBLIC_*` is inlined at build, not just the prefix

Found by Backend while wiring the service, and it is the same trap as the base
path with a worse symptom.

`NEXT_PUBLIC_REALTIME_URL` is read in two places that fail in opposite
directions, and **both look fine**:

| Where | When | Missing there means |
| --- | --- | --- |
| `realtime-provider.tsx` | **build** (inlined) | `undefined` → the provider returns `null` → **no socket is ever opened** |
| `proxy.ts` | runtime | the CSP omits the origin → the browser's connection is blocked |

Runtime-only is the dangerous one: the policy permits a connection nobody
attempts. No error, no console warning, no failed request — because there is no
request. Every screen renders, every navigation works, and the inbox never
updates.

All six public variables are now build args, and the placement is reasoned
rather than blanket: **all six** in the build stage because all six are inlined,
and **two** in the runtime stage because only those have a server-side runtime
reader — `NEXT_PUBLIC_BASE_PATH` (`next.config.ts` on `next start`) and
`NEXT_PUBLIC_REALTIME_URL` (the CSP). Repeating the other four at runtime would
imply an effect they do not have.

`scripts/public-env-sweep.ts` fails the run if a variable the source reads is
missing from the **build** stage. Its first version matched an `ARG` in any
stage and **passed this very defect**, since the runtime stage declared it — the
gate now splits on stage boundaries and reads only the stage that runs the
build.

## The base-path root was a 404, and the matcher entry that fixes it looks redundant

`/v2` returned a bare 404 — the exact URL somebody types — while `/v2/en`
worked. The cause is the middleware matcher:

    matcher: ['/((?!api|_next|_vercel|.*\..*).*)']

At the root that matches `/` with an empty tail. **Next prefixes each matcher
with the base path**, so it becomes `/v2/((?!…).*)` — and `/v2` has no slash
after `v2`, so the middleware never ran and nothing redirected the root to a
locale.

Adding a bare `'/'` entry fixes it, and that entry is **redundant at the root**,
which is the trap: it reads as removable.

Verified by building with the prefix and probing:

| request | before | after |
| --- | --- | --- |
| `/v2`, no session | 404 | 307 → `/v2/api/auth/login?returnTo=%2F` |
| `/v2`, no session, `Accept-Language: he` | 404 | the same — **the auth gate answers before locale negotiation** |
| `/v2`, with a session | 404 | 307 → `/v2/en` |
| `/v2`, with a session, `he` | 404 | 307 → `/v2/he` |
| `/v2/sign-in` (public), `he` / `en` / none | — | `/v2/he/sign-in` / `/v2/en/sign-in` / `/v2/en/sign-in` |
| `/en` | 404 | 404 — nothing bleeds into the legacy namespace |

An earlier version of this table reported the Hebrew redirect without saying the
request carried a session, which made it look like unauthenticated negotiation.
Backend could not reproduce it and was right to say so: the gate fires first.
The conclusion is unchanged — negotiation happens in the middleware — and the
public-path row is where it is visible without a session.

**In the middleware rather than the gateway**, deliberately: nginx could rewrite
`/v2` to `/v2/en` and it would put locale policy in the gateway, hardcode a
default language for a bilingual product, and leave the app 404ing at its own
root for anyone arriving another way. Here next-intl negotiates.

## Empty is not absent, and `ARG X=""` is set

`ARG X=""` declares an arg that **is set**, to the empty string, and `ENV X=$X`
sets it whether or not the arg was passed. Zod's `.optional()` and `.default()`
fire on `undefined` only, so an empty value does three different things —
measured, not reasoned:

| Shape | `''` | `undefined` |
| --- | --- | --- |
| `z.enum([…]).default('local')` | **throws** | `'local'` |
| `z.url().optional()` | **throws** | `undefined` |
| `z.coerce.number().min(0).max(1).default(0.1)` | **`0`, silently** | `0.1` |
| `z.string().min(1).optional()` | **throws** | `undefined` |
| `z.string().optional()` | `''` | `undefined` |

The first two take the browser bundle down at module load, so a healthy
container serves a blank app. The third turns tracing off and says nothing. The
fourth is the server-side one: a container whose sign-in page returns 200 and
whose login route 500s.

Fixed in two places, because either alone would leave the trap for the next
person:

- **`src/config/empty-is-unset.ts`** normalises empty to `undefined` for the
  whole object before either schema sees it. Only the empty *string* — `0` and
  `false` are values somebody set.
- **The Dockerfile** declares each `ARG` with no default and no build-stage
  `ENV`, so an unpassed variable is genuinely unset. Docker exposes arg values
  to `RUN`, so the build still sees them.

`src/config/env-shapes.test.ts` pins a test per *shape* rather than per
variable, and drives the real client module for the end-to-end case.

## A cookie `Path` is not a URL this app emits

`gotcha_login` was scoped to a hardcoded `/api/auth`. Authentik returns to
`/v2/api/auth/callback`, the browser **declines to send a cookie scoped to a
different path**, and the callback finds no PKCE verifier and reports
`sign-in?error=expired` — which reads as a timeout.

**Every layer reported success**: the gateway route, the registered redirect URI,
the `Location` headers, the prefixed bundle, `/en` still 404ing. A 307 with the
right `Location` is not a completed exchange.

And it was **invisible to every instrument built for this deployment**. The
build-arg sweep checks args; this audit walks redirect call sites; the config
tests check env shapes. A cookie `Path` is a constraint on which URLs the
*browser* will send a cookie to, so none of them can see it. It was found by
walking a real browser.

`LOGIN_STATE_COOKIE_PATH` now lives beside the cookie's name, and the setter and
the deleter read the same constant — a delete whose path does not match the set
is a **no-op**, which leaves a stale sealed state for the next attempt to pick
up, and that failure would come and go.

Swept the rest rather than reasoning about them: the only other cookie paths are
the session cookie at `/`, one setter and three deleters, all consistent and all
deliberately `/`. `NEXT_LOCALE` is written by next-intl, which prefixes it
itself.

## What a running container does not prove

`serverEnv()` is memoised on first access, so a container starts happily with a
missing secret and fails on the first request that needs it. A process that is
up is not evidence of an app that works; probe a page that exercises a read.

## Not verified, and why

- **The image has not been built.** Disk is at 90% with 7.8G free, and a build
  of this image costs two to three of them on a machine where a build was
  already killed by a full disk today. That is a shared resource and not mine to
  spend without asking.
- **A `.ts` config in a production-only install.** `next start` re-reads
  `next.config.ts`, and `typescript` is a devDependency. Next bundles
  `@next/swc-*`, which should parse it, but this is untested. If it fails it
  fails loudly at container start, not subtly — and the runtime stage sets
  `NEXT_PUBLIC_BASE_PATH` from the same build arg, so the server cannot serve a
  different prefix from the one the bundle was built for.
- **The build needs no server environment** — that *is* verified: building with
  `API_BASE_URL` set to an invalid value still produced all 68 static pages, so
  nothing prerendered calls `serverEnv()`. Platform credentials stay out of the
  image.
