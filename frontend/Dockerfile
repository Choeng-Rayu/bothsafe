# Frontend Dockerfile — Next.js (App Router) multi-stage build.
# Uses Next.js standalone output. Requires `output: "standalone"` in next.config.ts.
# Used by docker-compose.prod.yml only. Local dev runs on the host.

# ─── deps stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

# ─── build stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build-time public env. Must be passed in via --build-arg in docker compose.
ARG NEXT_PUBLIC_API_BASE
ARG NEXT_PUBLIC_APP_BASE_URL
ENV NEXT_PUBLIC_API_BASE=${NEXT_PUBLIC_API_BASE}
ENV NEXT_PUBLIC_APP_BASE_URL=${NEXT_PUBLIC_APP_BASE_URL}

RUN npm run build

# ─── runtime stage ────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Run as non-root.
RUN addgroup --system --gid 1001 nextjs && adduser --system --uid 1001 nextjs

# Standalone build copies just what the runtime needs.
COPY --from=build --chown=nextjs:nextjs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nextjs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nextjs /app/public ./public

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
