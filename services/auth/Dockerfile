FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app

# Copy shared package
COPY packages/shared/package.json packages/shared/
COPY packages/shared/prisma packages/shared/prisma/
COPY packages/shared/src packages/shared/src/
COPY packages/shared/tsconfig.json packages/shared/

# Copy service
COPY services/auth/package.json services/auth/
COPY services/auth/tsconfig.json services/auth/

# Root workspace
COPY package.json ./

RUN npm install
RUN cd packages/shared && npx prisma generate

COPY services/auth/src services/auth/src/

WORKDIR /app/services/auth
EXPOSE 4001
CMD ["npx", "tsx", "src/index.ts"]
