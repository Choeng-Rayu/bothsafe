#!/usr/bin/env bash
# BothSafe TLS certificate renewal via Let's Encrypt (§15.6).
#
# Initial issuance:
#   docker run --rm -v bothsafe-certbot-webroot:/var/www/certbot \
#     -v ./nginx/certs:/etc/letsencrypt \
#     certbot/certbot certonly --webroot -w /var/www/certbot \
#     -d yourdomain.com --agree-tos -m admin@yourdomain.com
#
# Schedule renewal via cron: 0 3 * * 1 /path/to/scripts/renew-certs.sh
#
# After renewal, reload nginx to pick up new certs.

set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"

docker run --rm \
  -v bothsafe-certbot-webroot:/var/www/certbot \
  -v "$(dirname "$0")/../nginx/certs:/etc/letsencrypt" \
  certbot/certbot renew --quiet

docker compose -f "$COMPOSE_FILE" exec nginx nginx -s reload

echo "Certificate renewal complete, nginx reloaded."
