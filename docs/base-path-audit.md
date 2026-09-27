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
