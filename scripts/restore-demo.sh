#!/usr/bin/env bash
# Put Django back at the demo commit and reload HydraDB after an eval run.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
COMMIT="${1:-febefb175e03352e5aeb2ed827024bacab96cf16}"
git -C data/repos/django checkout --quiet --force --detach "$COMMIT"
git -C data/repos/django clean -qfdx
bash scripts/db-reset.sh
node --no-warnings --import tsx --env-file-if-exists=.env packages/ingest/src/cli.ts \
  data/extract/django.jsonl data/extract/django.cochange.jsonl
echo "demo graph restored  django/django@$COMMIT"
