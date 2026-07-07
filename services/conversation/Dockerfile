FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app

COPY packages/shared/package.json packages/shared/
COPY packages/shared/prisma packages/shared/prisma/
COPY packages/shared/src packages/shared/src/
COPY packages/shared/tsconfig.json packages/shared/

COPY services/conversation/package.json services/conversation/
COPY services/conversation/tsconfig.json services/conversation/

COPY package.json ./

RUN npm install --maxsockets=3 --fetch-timeout=90000 --fetch-retries=12 --fetch-retry-mintimeout=3000 --fetch-retry-maxtimeout=30000
RUN cd packages/shared && npx prisma generate

COPY services/conversation/src services/conversation/src/

WORKDIR /app/services/conversation
EXPOSE 4002
CMD ["npx", "tsx", "src/index.ts"]
