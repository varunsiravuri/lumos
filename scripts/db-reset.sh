#!/usr/bin/env bash
# Destroy the local graph and start again from an empty store.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

docker compose -f infra/docker-compose.yml down
rm -rf .hydradb/minio .hydradb/cache 2>/dev/null || sudo rm -rf .hydradb/minio .hydradb/cache

# Node ids are allocated deterministically from a registry keyed by qualified
# name. Emptying the store without emptying the registry would leave ingestion
# writing to ids the graph no longer knows about.
rm -f data/ids.sqlite data/eval/ingested.json

exec bash scripts/db-up.sh
