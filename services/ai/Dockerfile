FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app

COPY packages/shared/package.json packages/shared/
COPY packages/shared/prisma packages/shared/prisma/
COPY packages/shared/src packages/shared/src/
COPY packages/shared/tsconfig.json packages/shared/

COPY services/ai/package.json services/ai/
COPY services/ai/tsconfig.json services/ai/

COPY package.json ./

RUN npm install
RUN cd packages/shared && npx prisma generate

COPY services/ai/src services/ai/src/

WORKDIR /app/services/ai
EXPOSE 4006
CMD ["npx", "tsx", "src/index.ts"]
