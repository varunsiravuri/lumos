#!/usr/bin/env bash
# Bring up the local HydraDB development node and block until it answers a query.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

mkdir -p .hydradb/minio .hydradb/cache

# The container runs as the host user so the bind-mounted cache stays writable.
export HOST_UID="${HOST_UID:-$(id -u)}"
export HOST_GID="${HOST_GID:-$(id -g)}"

docker compose -f infra/docker-compose.yml up -d

exec bash scripts/wait-for-hydradb.sh
