# syntax=docker/dockerfile:1

# ══════════════════════════════════════════════════════════════════════════════
# The v2 app, built to run beside the existing product and share nothing with it
# ══════════════════════════════════════════════════════════════════════════════
#
# SELF-CONTAINED ON PURPOSE. This installs its own dependencies and copies its
# own source; there is no bind mount and no path back into a working tree. The
# alternative — a `next dev` container mounted on the host — would share
# `node_modules` with whoever is developing, which is the one thing this
# deployment was asked not to do. It would also mean the container's behaviour
# depended on an editor's save.
#
# ── WHY NOT `output: 'standalone'` ──
# It would make a smaller image and it requires copying `public` and
# `.next/static` into place by hand. Getting that wrong produces a site that
# runs with no CSS — a failure that looks like a design problem. Until somebody
# needs the megabytes, a plain `next start` over the full install has fewer
# ways to be subtly wrong.

# ── deps ─────────────────────────────────────────────────────────────────────
# Separate stage so a source change does not reinstall. `npm ci` from the
# lockfile, never `npm install`: the deployed tree must be the resolved one.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── build ────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# ══════════════════════════════════════════════════════════════════════════════
# ★★ EVERY `NEXT_PUBLIC_*` VARIABLE IS INLINED HERE, AT BUILD, AND NOWHERE ELSE
# ══════════════════════════════════════════════════════════════════════════════
# Next replaces `process.env.NEXT_PUBLIC_X` with a literal when it compiles the
# client bundle. **A value supplied only at runtime does not exist for the
# browser** — and the failures are silent in both directions:
#
#   BASE_PATH      runtime only → the server routes under the prefix while the
#                  browser's own JavaScript fetches the root.
#   REALTIME_URL   runtime only → `realtime-provider` reads `undefined` and
#                  returns `null`, so **no socket is ever opened**. The CSP
#                  (read at runtime) permits a connection nobody attempts:
#                  no error, no console warning, no failed request, because
#                  there is no request. Every screen renders and the inbox
#                  never updates.
#                  Build only → the browser connects and the CSP blocks it.
#
# So this list is every `NEXT_PUBLIC_*` the source reads, checked by
# `scripts/public-env-sweep.ts` rather than kept in step by hand. An empty
# default is deliberate: the app treats each as optional and says so at the
# point of use, which is better than a container that will not start.
# ★★ NO DEFAULTS, AND NO `ENV` LINES — BOTH WOULD SET THESE TO EMPTY.
#
# `ARG X=""` declares an arg that **is set**, to the empty string, and
# `ENV X=$X` sets it whether or not the arg was passed. Empty is not the same
# as absent to a schema: `z.enum().default('local')` and `z.url().optional()`
# both **throw** on `''`, and `z.coerce.number().default(0.1)` silently becomes
# **0**. The first two take the browser bundle down at module load, so a
# healthy container serves a blank app to anyone who builds without passing
# every variable.
#
# An `ARG` with no default and no `ENV` is genuinely unset unless passed, and
# Docker exposes arg values to `RUN` as environment variables, so the build
# still sees them. `src/config/empty-is-unset.ts` covers the case anyway —
# belt and braces, because the next person to write a compose file will use
# `${X:-}`, which is the documented way to make a variable optional and also
# supplies empty.
ARG NEXT_PUBLIC_BASE_PATH
ARG NEXT_PUBLIC_REALTIME_URL
ARG NEXT_PUBLIC_APP_ENV
ARG NEXT_PUBLIC_RELEASE
ARG NEXT_PUBLIC_SENTRY_DSN
ARG NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE

# No server environment is needed here, and that is checked rather than
# assumed: building with `API_BASE_URL` set to an invalid value still produces
# all 68 static pages, because nothing prerendered calls `serverEnv()`. So the
# platform credentials stay out of the image and arrive from compose.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── run ──────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# ★★ THE TWO PUBLIC VARIABLES THAT ALSO HAVE A RUNTIME READER ON THE SERVER.
#
# The other four are consumed only by the client bundle, where they are already
# inlined; repeating them here would suggest a runtime effect they do not have.
# These two genuinely have one:
#
#   BASE_PATH      `next.config.ts` recomputes `basePath` when `next start`
#                  re-reads it. Build and runtime disagreeing would serve a
#                  different prefix from the one the bundle carries.
#   REALTIME_URL   `proxy.ts` puts the socket origin in the Content-Security-
#                  Policy on every request. Missing here and the CSP omits the
#                  origin, so the connection the bundle attempts is blocked.
#
# Both come from the same build args, so the two halves cannot drift.
# These two DO get `ENV`, because server code reads them at runtime. An empty
# value is safe for both: `next.config.ts` treats `''` as the root, and the CSP
# builder tests `realtimeUrl` for truthiness, so `''` behaves as absent there.
ARG NEXT_PUBLIC_BASE_PATH
ARG NEXT_PUBLIC_REALTIME_URL
ENV NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH
ENV NEXT_PUBLIC_REALTIME_URL=$NEXT_PUBLIC_REALTIME_URL

# Production dependencies only. The build's devDependencies — the compiler, the
# test runner, the linters — have no business in a running container.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/next.config.ts ./next.config.ts

# `node` exists in the base image as an unprivileged user. Nothing here writes
# to the filesystem at runtime, so it owns nothing it does not need.
USER node

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["npm", "run", "start"]
