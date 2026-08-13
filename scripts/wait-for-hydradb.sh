#!/usr/bin/env bash
# Block until the local HydraDB node is genuinely usable.
#
# A listening port is not proof the node works, and neither is /readyz on its own:
# graph-node can answer /readyz and then abort on the first query if RUST_MIN_STACK
# is unset. So this waits for readiness and then round-trips an actual query.
set -euo pipefail

ADMIN_URL="${HYDRA_ADMIN_URL:-http://127.0.0.1:9090}"
HTTP_URL="${HYDRA_HTTP_URL:-http://127.0.0.1:8443}"
TOKEN="${HYDRA_AUTH_TOKEN:-local-development-token-32-bytes}"
NAMESPACE="${HYDRA_NAMESPACE:-default}"
GRAPH="${HYDRA_GRAPH:-default}"
CELL="${HYDRA_CELL_ID:-cell-0}"
TIMEOUT_SECONDS="${HYDRA_WAIT_TIMEOUT:-180}"

deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))

printf 'waiting for HydraDB at %s ' "$ADMIN_URL"
until curl -fsS -m 5 "$ADMIN_URL/readyz" >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    printf '\nhydradb did not become ready within %ss\n' "$TIMEOUT_SECONDS" >&2
    printf 'check the node log with: docker compose -f infra/docker-compose.yml logs\n' >&2
    exit 1
  fi
  printf '.'
  sleep 2
done
printf ' ready\n'

# A bare `RETURN 1` is rejected: the row executor only runs MATCH ... RETURN.
# A label-only match against a label nothing uses is the cheapest valid probe.
response="$(curl -fsS -m 15 "$HTTP_URL/v1/graphs/$GRAPH/query" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Graph-Namespace: $NAMESPACE" \
  -H 'Content-Type: application/json' \
  --data "{\"cell_id\":\"$CELL\",\"query\":\"MATCH (n:__lumos_ping) RETURN n.id AS ok LIMIT 1\"}")"

if ! printf '%s' "$response" | grep -q '"columns"'; then
  printf 'hydradb is listening but did not answer a query as expected:\n%s\n' "$response" >&2
  exit 1
fi

printf 'hydradb-ok (query round-trip succeeded)\n'
