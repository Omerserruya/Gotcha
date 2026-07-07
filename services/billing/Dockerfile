FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app

# Copy shared package
COPY packages/shared/package.json packages/shared/
COPY packages/shared/prisma packages/shared/prisma/
COPY packages/shared/src packages/shared/src/
COPY packages/shared/tsconfig.json packages/shared/

# Copy service
COPY services/billing/package.json services/billing/
COPY services/billing/tsconfig.json services/billing/

# Root workspace
COPY package.json ./

RUN npm install --maxsockets=3 --fetch-timeout=90000 --fetch-retries=12 --fetch-retry-mintimeout=3000 --fetch-retry-maxtimeout=30000
RUN cd packages/shared && npx prisma generate

COPY services/billing/src services/billing/src/

WORKDIR /app/services/billing
EXPOSE 4009
CMD ["npx", "tsx", "src/index.ts"]
