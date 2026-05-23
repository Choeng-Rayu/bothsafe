# Backend Dockerfile — NestJS multi-stage build.
# Used by docker-compose.prod.yml only. Local dev runs on the host.

# ─── deps stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

# OpenSSL is required by Prisma at runtime on alpine.
RUN apk add --no-cache openssl

COPY package.json package-lock.json ./
RUN npm ci

# ─── build stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

RUN apk add --no-cache openssl

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate prisma client + compile TS.
# The `prisma` directory must exist before this works; if you haven't created
# the schema yet, this stage will fail until you do.
RUN npx prisma generate || true
RUN npm run build

# Drop dev dependencies for the runtime image.
RUN npm prune --omit=dev

# ─── runtime stage ────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache openssl tini

ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# Prisma schema and migrations are needed at runtime for `prisma migrate deploy`.
COPY --from=build /app/prisma ./prisma 2>/dev/null || true

EXPOSE 3003

# tini reaps zombies and forwards signals so SIGTERM cleanly stops Nest.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main"]
