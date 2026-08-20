#!/usr/bin/env bash
# Back up irreplaceable application state. Repository clones and the graph can
# be rebuilt from their public sources, so they are intentionally excluded.
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/lumos}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/lumos}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="$BACKUP_DIR/lumos-state-$STAMP.tar.gz"

umask 077
sudo install -d -m 700 "$BACKUP_DIR"

items=()
for item in .env infra/auth-token data/workspaces.json data/lumos; do
  if [[ -e "$APP_DIR/$item" ]]; then
    items+=("$item")
  fi
done

if [[ "${#items[@]}" -eq 0 ]]; then
  echo "No Lumos state files found under $APP_DIR" >&2
  exit 1
fi

sudo tar -C "$APP_DIR" -czf "$ARCHIVE" "${items[@]}"
sudo chmod 600 "$ARCHIVE"
sudo find "$BACKUP_DIR" -type f -name 'lumos-state-*.tar.gz' -mtime "+$RETENTION_DAYS" -delete
sudo tar -tzf "$ARCHIVE" >/dev/null
echo "$ARCHIVE"

