FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app

COPY packages/shared/package.json packages/shared/
COPY packages/shared/prisma packages/shared/prisma/
COPY packages/shared/src packages/shared/src/
COPY packages/shared/tsconfig.json packages/shared/

COPY services/outgoing-worker/package.json services/outgoing-worker/
COPY services/outgoing-worker/tsconfig.json services/outgoing-worker/

COPY package.json ./

RUN npm install --maxsockets=3 --fetch-timeout=90000 --fetch-retries=12 --fetch-retry-mintimeout=3000 --fetch-retry-maxtimeout=30000
RUN cd packages/shared && npx prisma generate

COPY services/outgoing-worker/src services/outgoing-worker/src/

WORKDIR /app/services/outgoing-worker
# No EXPOSE - this is a worker-only service (no HTTP server)
CMD ["npx", "tsx", "src/index.ts"]
