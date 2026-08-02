# ─── Builder: full install (dev toolchain) + prisma generate ────────────
FROM node:20-alpine AS builder
RUN apk add --no-cache openssl
WORKDIR /app

COPY packages/shared/package.json packages/shared/
COPY packages/shared/prisma packages/shared/prisma/
COPY packages/shared/tsconfig.json packages/shared/
COPY services/chatbot/package.json services/chatbot/
COPY services/chatbot/tsconfig.json services/chatbot/
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
COPY services/chatbot/package.json services/chatbot/
COPY services/chatbot/tsconfig.json services/chatbot/
COPY services/chatbot/src services/chatbot/src/
COPY package.json package-lock.json ./

RUN npm ci --omit=dev --maxsockets=3 --fetch-timeout=90000 --fetch-retries=12 --fetch-retry-mintimeout=3000 --fetch-retry-maxtimeout=30000
# Bring the generated prisma client (types + query engine) from the builder;
# `npm ci --omit=dev` installs the @prisma/client PACKAGE but not the generated
# output, so copy both the package and the generated .prisma dir.
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client

# Drop root (M-8): run as the image's built-in unprivileged `node` user.
USER node

WORKDIR /app/services/chatbot
EXPOSE 4005
CMD ["npx", "tsx", "src/index.ts"]
