#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${DOMAIN:-lumos.uno}"
API_URL="${API_URL:-http://127.0.0.1:8787/health}"
WEB_URL="${WEB_URL:-http://127.0.0.1:3000/app/workspace}"
PUBLIC_URL="${PUBLIC_URL:-https://$DOMAIN/app/workspace}"

curl --fail --silent --show-error --max-time 15 "$API_URL" >/dev/null
curl --fail --silent --show-error --max-time 15 "$WEB_URL" >/dev/null
curl --fail --silent --show-error --max-time 20 "$PUBLIC_URL" >/dev/null
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) lumos healthcheck passed"

