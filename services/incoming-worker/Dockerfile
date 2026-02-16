FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app

COPY packages/shared/package.json packages/shared/
COPY packages/shared/prisma packages/shared/prisma/
COPY packages/shared/src packages/shared/src/
COPY packages/shared/tsconfig.json packages/shared/

COPY services/incoming-worker/package.json services/incoming-worker/
COPY services/incoming-worker/tsconfig.json services/incoming-worker/

COPY package.json ./

RUN npm install
RUN cd packages/shared && npx prisma generate

COPY services/incoming-worker/src services/incoming-worker/src/

WORKDIR /app/services/incoming-worker
# No EXPOSE - this is a worker-only service (no HTTP server)
CMD ["npx", "tsx", "src/index.ts"]
