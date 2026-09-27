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

# ★★ THE MOUNT POINT IS A BUILD ARG, NOT A RUNTIME VARIABLE.
#
# `basePath` is applied when `next build` runs and is INLINED into the client
# bundle. Supplying it only at runtime does nothing at all — the server would
# route under the prefix while the browser's own JavaScript fetched the root.
# That is the failure this line exists to prevent, and it is silent.
ARG NEXT_PUBLIC_BASE_PATH=""
ENV NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH

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

# ★★ THE SAME MOUNT POINT AT RUNTIME, BECAUSE `next start` RE-READS THE CONFIG.
#
# `next.config.ts` computes `basePath` from this variable. If the build had it
# and the running container did not, the server would serve at the root while
# `.next` and the client bundle were built for the prefix — a disagreement
# between two halves of the same image. Declared from the same build arg so
# they cannot drift.
ARG NEXT_PUBLIC_BASE_PATH=""
ENV NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH

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
