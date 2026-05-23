#!/usr/bin/env bash
# Bring up the local dev data services.
#
# Usage:
#   ./scripts/dev-up.sh           # start postgres + minio + redis
#   ./scripts/dev-up.sh down      # stop, keep volumes
#   ./scripts/dev-up.sh nuke      # stop + WIPE volumes (destructive)
#
# Backend and frontend run on the host:
#   cd backend && npm run start:dev
#   cd frontend && npm run dev

set -euo pipefail

cd "$(dirname "$0")/.."

cmd="${1:-up}"

case "$cmd" in
  up)
    docker compose up -d
    docker compose ps
    echo
    echo "Postgres : postgresql://bothsafe:bothsafe@localhost:55432/bothsafe"
    echo "MinIO    : http://localhost:59000  (console http://localhost:59001  — minioadmin / minioadmin)"
    echo "Redis    : redis://localhost:56379"
    echo
    echo "Next:"
    echo "  cd backend  && cp -n .env.example .env && npm install && npm run start:dev"
    echo "  cd frontend && cp -n .env.example .env.local && npm install && npm run dev"
    ;;
  down)
    docker compose down
    ;;
  nuke)
    read -rp "This will DELETE all postgres + minio + redis data. Type 'yes' to continue: " confirm
    [[ "$confirm" == "yes" ]] || { echo "aborted"; exit 1; }
    docker compose down -v
    ;;
  logs)
    shift || true
    docker compose logs -f "$@"
    ;;
  *)
    echo "usage: $0 {up|down|nuke|logs [service]}" >&2
    exit 2
    ;;
esac
