FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app

COPY packages/shared/package.json packages/shared/
COPY packages/shared/prisma packages/shared/prisma/
COPY packages/shared/src packages/shared/src/
COPY packages/shared/tsconfig.json packages/shared/

COPY services/voice-copilot/package.json services/voice-copilot/
COPY services/voice-copilot/tsconfig.json services/voice-copilot/

COPY package.json ./

RUN npm install --maxsockets=3 --fetch-timeout=90000 --fetch-retries=12 --fetch-retry-mintimeout=3000 --fetch-retry-maxtimeout=30000
RUN cd packages/shared && npx prisma generate

COPY services/voice-copilot/src services/voice-copilot/src/

WORKDIR /app/services/voice-copilot
EXPOSE 4007
CMD ["npx", "tsx", "src/index.ts"]
