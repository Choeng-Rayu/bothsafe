#!/usr/bin/env bash
# BothSafe Postgres backup script (§15.5).
# Runs pg_dump via the production docker compose postgres container.
# Schedule via cron: 0 2 * * * /path/to/scripts/backup.sh
#
# Retention: 14 days.

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/bothsafe/backups/postgres}"
RETENTION_DAYS=14
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
TIMESTAMP=$(date +%F_%H%M)

mkdir -p "$BACKUP_DIR"

docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U bothsafe -Fc bothsafe \
  > "$BACKUP_DIR/$TIMESTAMP.dump"

echo "Backup created: $BACKUP_DIR/$TIMESTAMP.dump"

# Prune old backups
find "$BACKUP_DIR" -name "*.dump" -mtime +$RETENTION_DAYS -delete

echo "Pruned backups older than $RETENTION_DAYS days."
