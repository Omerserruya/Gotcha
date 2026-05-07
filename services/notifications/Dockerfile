FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app

# Copy shared package
COPY packages/shared/package.json packages/shared/
COPY packages/shared/prisma packages/shared/prisma/
COPY packages/shared/src packages/shared/src/
COPY packages/shared/tsconfig.json packages/shared/

# Copy service
COPY services/notifications/package.json services/notifications/
COPY services/notifications/tsconfig.json services/notifications/

# Root workspace
COPY package.json ./

RUN npm install
RUN cd packages/shared && npx prisma generate

COPY services/notifications/src services/notifications/src/

WORKDIR /app/services/notifications
EXPOSE 4008
CMD ["npx", "tsx", "src/index.ts"]
