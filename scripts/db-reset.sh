#!/usr/bin/env bash
# Destroy the local graph and start again from an empty store.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

docker compose -f infra/docker-compose.yml down
rm -rf .hydradb/store .hydradb/cache

exec bash scripts/db-up.sh
