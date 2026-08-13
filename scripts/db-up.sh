#!/usr/bin/env bash
# Bring up the local HydraDB development node and block until it answers a query.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

mkdir -p .hydradb/store .hydradb/cache

# LOCAL_PATH must point at a directory that already exists, and the container
# runs as the host user so the bind mounts stay writable.
export HOST_UID="${HOST_UID:-$(id -u)}"
export HOST_GID="${HOST_GID:-$(id -g)}"

docker compose -f infra/docker-compose.yml up -d

exec bash scripts/wait-for-hydradb.sh
