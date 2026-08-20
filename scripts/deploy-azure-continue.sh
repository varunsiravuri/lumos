#!/usr/bin/env bash
# Continue Lumos deploy after code is rsync'd to ~/lumos (private repo path).
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/lumos}"
PUBLIC_IP="${PUBLIC_IP:-20.121.200.102}"
DOMAIN="${DOMAIN:-lumos.uno}"
cd "$APP_DIR"

if ! docker info >/dev/null 2>&1; then
  exec sg docker -c "PUBLIC_IP=${PUBLIC_IP} APP_DIR=${APP_DIR} bash $0"
fi

if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

if [[ ! -f .env ]]; then
  TOKEN="$(openssl rand -hex 16)"
  echo "$TOKEN" > infra/auth-token
  UID_NUM="$(id -u)"
  GID_NUM="$(id -g)"
  cat > .env <<EOF
HYDRA_HTTP_URL=http://127.0.0.1:8443
HYDRA_BOLT_URL=neo4j://127.0.0.1:7687
HYDRA_ADMIN_URL=http://127.0.0.1:9090
HYDRA_AUTH_TOKEN=$TOKEN
HYDRA_NAMESPACE=default
HYDRA_GRAPH=default
HYDRA_CELL_ID=cell-0
HOST_UID=$UID_NUM
HOST_GID=$GID_NUM
LUMOS_REPO=django/django
LUMOS_ROOT=$APP_DIR/data/repos/django
LUMOS_API_HOST=127.0.0.1
LUMOS_ALLOWED_ORIGINS=https://$DOMAIN
MINIO_USER=lumos
MINIO_PASSWORD=$(openssl rand -hex 24)
EOF
else
  grep '^HYDRA_AUTH_TOKEN=' .env | cut -d= -f2- > infra/auth-token
  grep -q '^LUMOS_API_HOST=' .env || echo 'LUMOS_API_HOST=127.0.0.1' >> .env
  grep -q '^LUMOS_ALLOWED_ORIGINS=' .env || echo "LUMOS_ALLOWED_ORIGINS=https://$DOMAIN" >> .env
  grep -q '^MINIO_USER=' .env || echo 'MINIO_USER=lumos' >> .env
  grep -q '^MINIO_PASSWORD=' .env || echo "MINIO_PASSWORD=$(openssl rand -hex 24)" >> .env
fi
chmod 600 .env infra/auth-token

pnpm install

set -a
# shellcheck disable=SC1091
source .env
set +a

mkdir -p data/repos
if [[ ! -d data/repos/django/.git ]]; then
  git clone --depth 1 https://github.com/django/django.git data/repos/django
fi
git -C data/repos/django fetch --depth 1 origin febefb175e03352e5aeb2ed827024bacab96cf16
git -C data/repos/django checkout --force --detach febefb175e03352e5aeb2ed827024bacab96cf16

pnpm db:down || true
pnpm db:up
sleep 5
for attempt in 1 2 3 4 5; do
  if pnpm probe; then
    break
  fi
  if [[ "$attempt" -eq 5 ]]; then
    echo "HydraDB probe failed after $attempt attempts" >&2
    exit 1
  fi
  sleep 3
done

if [[ -f data/extract/django.jsonl ]]; then
  echo "==> ingest from extract (fast)"
  node --no-warnings --import tsx --env-file-if-exists=.env packages/ingest/src/cli.ts \
    data/extract/django.jsonl data/extract/django.cochange.jsonl \
    --chunk-size "${LUMOS_INGEST_CHUNK_SIZE:-250}"
else
  echo "==> full index (slow)"
  LUMOS_INGEST_CHUNK_SIZE="${LUMOS_INGEST_CHUNK_SIZE:-250}" pnpm lumos index data/repos/django --slug django/django
fi

mkdir -p data/swebench
if [[ ! -s data/swebench/lite.jsonl ]]; then
  pnpm swebench --repo django/django > data/swebench/lite.jsonl || true
fi

export NEXT_PUBLIC_LUMOS_API="/api"
pnpm --filter web build

sudo apt-get install -y nginx
DOMAIN="$DOMAIN" ./scripts/configure-production.sh

sudo tee /etc/systemd/system/lumos-api.service >/dev/null <<UNIT
[Unit]
Description=Lumos API
After=docker.service
Requires=docker.service

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=/usr/bin/node --no-warnings --import tsx --env-file-if-exists=.env packages/serve/src/index.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/lumos-web.service >/dev/null <<UNIT
[Unit]
Description=Lumos Web
After=lumos-api.service

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR/apps/web
Environment=NEXT_PUBLIC_LUMOS_API=/api
Environment=PORT=3000
ExecStart=$APP_DIR/apps/web/node_modules/.bin/next start -H 127.0.0.1 -p 3000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now lumos-api lumos-web
if sudo test -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem"; then
  DOMAIN="$DOMAIN" APP_DIR="$APP_DIR" ./scripts/install-production-ops.sh
else
  echo "After issuing the TLS certificate, rerun configure-production.sh and install-production-ops.sh."
fi

curl -sf "http://127.0.0.1:8787/health" && echo " api-ok"
curl -sf -o /dev/null -w "web-%{http_code}\n" "http://127.0.0.1:3000"
echo "deploy-ok  https://${DOMAIN}/"
