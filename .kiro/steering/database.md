---
inclusion: always
---

# BothSafe — Database & Data Services Context

This file is the source of truth for how data services run in **development**
and **production**. It is auto-loaded into every session.

> ⚠️ Doc drift: `AGENTS.md` currently says MySQL, but the real infra in
> `docker-compose.yml`, `docker-compose.prod.yml`, and
> `backend/.env.example` is **PostgreSQL 16**. Treat Postgres as the truth
> until `AGENTS.md` is updated.

---

## TL;DR

| Service   | Engine            | Dev (host)              | Prod (inside compose net) |
|-----------|-------------------|-------------------------|---------------------------|
| Database  | PostgreSQL 16-alpine | `localhost:55432`    | `postgres:5432`           |
| Cache     | Redis 7-alpine    | `localhost:56379`       | `redis:6379`              |
| Storage   | MinIO (S3-compatible) | API `localhost:59000`, console `localhost:59001` | `minio:9000` |
| ORM       | Prisma            | `npx prisma migrate dev` | migrations run from backend container |

DB name / user are the same in both envs: db `bothsafe`, user `bothsafe`.

---

## Development

Defined in `/docker-compose.yml`. Only **data services** run in Docker; the
NestJS backend and Next.js frontend run on the host for fast hot reload.

- Postgres
  - container: `bothsafe-dev-postgres`
  - image: `postgres:16-alpine`
  - host port `55432` → container `5432` (offset to avoid colliding with any
    local Postgres)
  - credentials (dev only): user `bothsafe`, password `bothsafe`, db `bothsafe`
  - volume: `bothsafe-dev-postgres-data`
  - healthcheck: `pg_isready -U bothsafe -d bothsafe`
- MinIO
  - container: `bothsafe-dev-minio`
  - host ports `59000` (S3 API) / `59001` (web console)
  - root user/pass: `minioadmin` / `minioadmin`
  - companion job `bothsafe-dev-minio-init` creates bucket `bothsafe` and sets
    anonymous download on first boot (idempotent)
- Redis
  - container: `bothsafe-dev-redis`, host port `56379`, AOF persistence on

Commands:

```bash
docker compose up -d         # start data services
docker compose ps
docker compose down          # stop, keep data
docker compose down -v       # stop + WIPE all dev data (destructive)
```

Backend env (from `backend/.env.example`):

```
DATABASE_URL=postgresql://bothsafe:bothsafe@localhost:55432/bothsafe?schema=public
REDIS_URL=redis://localhost:56379
MINIO_ENDPOINT=localhost
MINIO_PORT=59000
MINIO_USE_SSL=false
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=bothsafe
```

Schema workflow:

```bash
cd backend
npx prisma migrate dev          # create + apply migrations
npx prisma db seed              # seed test data
npx prisma studio               # GUI at localhost:5555
```

---

## Production

Defined in `/docker-compose.prod.yml`. Single VPS, everything containerized
including nginx, frontend, backend, postgres, minio, redis on the
`bothsafe-net` bridge network.

- **Only nginx exposes host ports** (`80`, `443`). Postgres, Redis, MinIO,
  backend, and frontend are reachable only on the internal docker network.
- Service hostnames inside the network: `postgres`, `redis`, `minio`,
  `backend`, `frontend`, `nginx`.
- Backend connection string in compose:
  ```
  DATABASE_URL=postgresql://bothsafe:${POSTGRES_PASSWORD}@postgres:5432/bothsafe?schema=public
  REDIS_URL=redis://redis:6379
  MINIO_ENDPOINT=minio
  MINIO_PORT=9000
  ```
- Required prod env (loaded from `.env` next to `docker-compose.prod.yml`):
  `POSTGRES_PASSWORD`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`,
  `JWT_SECRET`, `SESSION_SECRET`, `ENCRYPTION_MASTER_KEY`,
  `ADMIN_BOOTSTRAP_EMAIL`, `ADMIN_BOOTSTRAP_PASSWORD`,
  `APP_BASE_URL`, `CORS_ORIGINS`,
  `BAKONG_ACCOUNT_ID`, `BAKONG_API_TOKEN`,
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`,
  `TELEGRAM_CLIENT_ID`, `TELEGRAM_CLIENT_SECRET`,
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `AUTH_CALLBACK_BASE_URL`,
  `NEXT_PUBLIC_API_BASE`, `NEXT_PUBLIC_APP_BASE_URL`.
- Volumes (named, persist across `down`):
  `bothsafe-postgres-data`, `bothsafe-minio-data`, `bothsafe-redis-data`,
  `bothsafe-certbot-webroot`.
  `down -v` **wipes all production data**, including the database.

Commands:

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs -f backend
docker compose -f docker-compose.prod.yml exec backend npx prisma migrate deploy
docker compose -f docker-compose.prod.yml exec postgres \
  pg_dump -U bothsafe bothsafe > backup-$(date +%F).sql
```

Migration policy:

- Dev: `prisma migrate dev` (generates + applies + may reset).
- Prod: **only** `prisma migrate deploy` (apply existing migrations, never
  generate, never reset).

---

## Rules for the agent

1. Use Postgres syntax/types in any SQL or Prisma schema work. Do not assume
   MySQL features (e.g. `AUTO_INCREMENT`, `ENGINE=InnoDB`, `ON UPDATE
   CURRENT_TIMESTAMP`). Prefer `serial`/`uuid`, `timestamptz`, `jsonb`,
   `citext` where useful.
2. Never run `prisma migrate reset`, `db push --force-reset`, `down -v`, or
   any destructive command against production without an explicit user
   confirmation in the same turn.
3. When suggesting connection details, match the environment:
   - Dev examples → `localhost:55432`, `localhost:56379`, `localhost:59000`.
   - Prod / in-container examples → `postgres:5432`, `redis:6379`,
     `minio:9000`.
4. Treat MinIO as the only object store for the MVP. Do not introduce S3,
   GCS, R2, etc.
5. Treat Redis as available for caching, rate-limit buckets, queues, and
   short-lived state (invite tokens, session refresh, idempotency keys).
6. The bucket `bothsafe` already exists in both environments. Don't create
   per-feature buckets; use prefixes (`payment-proofs/`, `shipping-proofs/`,
   `disputes/`, `products/`).
7. CORS, JWT, and OAuth secrets differ per environment. Never bake prod
   secrets into source or example files; reference env vars instead.
8. If `AGENTS.md` and this file disagree about the database engine, **this
   file wins** until the discrepancy is resolved.
