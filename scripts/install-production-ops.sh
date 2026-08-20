#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/lumos}"
DOMAIN="${DOMAIN:-lumos.uno}"
USER_NAME="${SUDO_USER:-$USER}"

sudo tee /etc/systemd/system/lumos-healthcheck.service >/dev/null <<UNIT
[Unit]
Description=Lumos production health check
After=network-online.target lumos-api.service lumos-web.service nginx.service

[Service]
Type=oneshot
User=$USER_NAME
WorkingDirectory=$APP_DIR
Environment=DOMAIN=$DOMAIN
ExecStart=$APP_DIR/scripts/production-healthcheck.sh
UNIT

sudo tee /etc/systemd/system/lumos-healthcheck.timer >/dev/null <<'UNIT'
[Unit]
Description=Check Lumos production every five minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Persistent=true

[Install]
WantedBy=timers.target
UNIT

sudo tee /etc/systemd/system/lumos-backup.service >/dev/null <<UNIT
[Unit]
Description=Back up Lumos application state

[Service]
Type=oneshot
User=root
Environment=APP_DIR=$APP_DIR
ExecStart=$APP_DIR/scripts/backup-production.sh
UNIT

sudo tee /etc/systemd/system/lumos-backup.timer >/dev/null <<'UNIT'
[Unit]
Description=Back up Lumos state nightly

[Timer]
OnCalendar=*-*-* 02:15:00 UTC
RandomizedDelaySec=15min
Persistent=true

[Install]
WantedBy=timers.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now lumos-healthcheck.timer lumos-backup.timer
sudo systemctl start lumos-healthcheck.service
sudo systemctl start lumos-backup.service

