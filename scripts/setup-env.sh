#!/usr/bin/env bash
#
# Generates a .env with fresh random secrets.
#
# Idempotent by design: if .env already exists nothing is overwritten, because
# regenerating APP_ENCRYPTION_KEY would lock every user out of their stored webhook.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

if [[ -f "$ENV_FILE" ]]; then
  echo ".env already exists at $ENV_FILE"
  echo "Leaving it untouched. Delete it (or edit it) if you want new secrets."
  exit 0
fi

if [[ ! -f "$ROOT/.env.example" ]]; then
  echo "error: .env.example not found; run this from a checkout of the repo" >&2
  exit 1
fi

ENCRYPTION_KEY="$(gen_secret)"
JWT_SECRET="$(gen_secret)"
DB_PASSWORD="$(gen_secret)"
DB_PASSWORD="${DB_PASSWORD//[\/&]/}"

sed \
  -e "s|^APP_ENCRYPTION_KEY=.*|APP_ENCRYPTION_KEY=${ENCRYPTION_KEY}|" \
  -e "s|^JWT_SECRET=.*|JWT_SECRET=${JWT_SECRET}|" \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${DB_PASSWORD}|" \
  "$ROOT/.env.example" > "$ENV_FILE"

chmod 600 "$ENV_FILE"

cat <<EOF

Created $ENV_FILE with freshly generated secrets.

  JWT_SECRET           ${JWT_SECRET:0:8}...
  APP_ENCRYPTION_KEY   ${ENCRYPTION_KEY:0:8}...   <- back this up, losing it locks users out
  POSTGRES_PASSWORD    ${DB_PASSWORD:0:8}...

Next:
  1. Change ADMIN_PASSWORD in .env before exposing this deployment.
  2. Set COOKIE_SECURE=true once you serve over HTTPS.
  3. docker compose up --build

EOF
