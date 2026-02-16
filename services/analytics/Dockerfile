FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app

COPY packages/shared/package.json packages/shared/
COPY packages/shared/prisma packages/shared/prisma/
COPY packages/shared/src packages/shared/src/
COPY packages/shared/tsconfig.json packages/shared/

COPY services/analytics/package.json services/analytics/
COPY services/analytics/tsconfig.json services/analytics/

COPY package.json ./

RUN npm install
RUN cd packages/shared && npx prisma generate

COPY services/analytics/src services/analytics/src/

WORKDIR /app/services/analytics
EXPOSE 4004
CMD ["npx", "tsx", "src/index.ts"]
