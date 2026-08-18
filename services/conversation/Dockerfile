# ─── Builder: full install (dev toolchain) + prisma generate ────────────
FROM node:20-alpine AS builder
RUN apk add --no-cache openssl
WORKDIR /app

COPY packages/shared/package.json packages/shared/
COPY packages/shared/prisma packages/shared/prisma/
COPY packages/shared/tsconfig.json packages/shared/
COPY services/conversation/package.json services/conversation/
COPY services/conversation/tsconfig.json services/conversation/
COPY package.json package-lock.json ./

# Reproducible install from the committed lockfile; prisma CLI (a devDep) is
# present here to generate the client into node_modules/.prisma.
RUN npm ci --maxsockets=3 --fetch-timeout=90000 --fetch-retries=12 --fetch-retry-mintimeout=3000 --fetch-retry-maxtimeout=30000
RUN cd packages/shared && npx prisma generate

# ─── Runtime: production dependencies only ──────────────────────────────
# Fresh prod-only install (no vitest/typescript/prisma-CLI), then the
# generated prisma client is copied over from the builder. Supply-chain
# hardening H-6: the dev toolchain never ships in the running container.
FROM node:20-alpine AS runtime
RUN apk add --no-cache openssl
WORKDIR /app

COPY packages/shared/package.json packages/shared/
COPY packages/shared/prisma packages/shared/prisma/
COPY packages/shared/tsconfig.json packages/shared/
COPY packages/shared/src packages/shared/src/
COPY services/conversation/package.json services/conversation/
COPY services/conversation/tsconfig.json services/conversation/
COPY services/conversation/src services/conversation/src/
COPY package.json package-lock.json ./

RUN npm ci --omit=dev --maxsockets=3 --fetch-timeout=90000 --fetch-retries=12 --fetch-retry-mintimeout=3000 --fetch-retry-maxtimeout=30000
# Bring the generated prisma client (types + query engine) from the builder;
# `npm ci --omit=dev` installs the @prisma/client PACKAGE but not the generated
# output, so copy both the package and the generated .prisma dir.
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client

# Drop root (M-8): run as the image's built-in unprivileged `node` user.
# Which commit this image was built from - logged at boot and exposed on /health
# so deploy verification never depends on guessing whether a cache layer is stale.
ARG BUILD_SHA=dev
ENV BUILD_SHA=$BUILD_SHA
# The uploads volume mounts here, and this directory has to EXIST in the image
# before that happens.
#
# Docker seeds a named volume from the image path it is mounted at, ownership
# included - but only when the image actually has that path. Without this line
# Docker created /app/uploads itself, root-owned and mode 755, and the service
# below runs as `node` (uid 1000). Every inbound WhatsApp image, voice note and
# document then failed at fs.writeFileSync with EACCES, was swallowed by the
# media resolver's catch, and reached the agent as "media unavailable" with the
# real reason nowhere. Confirmed in production 2026-08-18.
#
# NOTE for anyone repairing an existing deployment: this fixes new volumes only.
# Docker will not re-seed a volume that already has files in it, so a box that
# has been running keeps the root-owned directory until it is chowned once by
# hand. See docs/operations/uploads-permissions.md.
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads

USER node

WORKDIR /app/services/conversation
EXPOSE 4002
CMD ["npx", "tsx", "src/index.ts"]
