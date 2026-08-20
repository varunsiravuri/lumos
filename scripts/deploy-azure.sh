#!/usr/bin/env bash
# One-shot Lumos demo deploy on Ubuntu (Azure VM). Run on the server as azureuser.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/varunsiravuri/lumos.git}"
APP_DIR="${APP_DIR:-$HOME/lumos}"
PUBLIC_IP="${PUBLIC_IP:-}"

echo "==> install docker (if needed)"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER"
fi
if ! docker info >/dev/null 2>&1; then
  exec sg docker -c "PUBLIC_IP=${PUBLIC_IP} REPO_URL=${REPO_URL} APP_DIR=${APP_DIR} bash $0"
fi

echo "==> install node 20 + pnpm (if needed)"
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs git python3
fi
if ! command -v pnpm >/dev/null; then
  sudo corepack enable
  corepack prepare pnpm@10.15.0 --activate
fi

echo "==> clone lumos"
if [[ ! -d "$APP_DIR/.git" ]]; then
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
git pull --ff-only || true

TOKEN="$(openssl rand -hex 16)"
echo "$TOKEN" > infra/auth-token
cp .env.example .env
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
EOF

pnpm install

echo "==> django checkout"
mkdir -p data/repos
if [[ ! -d data/repos/django/.git ]]; then
  git clone https://github.com/django/django.git data/repos/django
fi
git -C data/repos/django fetch --depth 1 origin febefb175e03352e5aeb2ed827024bacab96cf16
git -C data/repos/django checkout --force --detach febefb175e03352e5aeb2ed827024bacab96cf16

echo "==> hydradb"
pnpm db:up
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

echo "==> index django (slow)"
LUMOS_INGEST_CHUNK_SIZE="${LUMOS_INGEST_CHUNK_SIZE:-250}" pnpm lumos index data/repos/django --slug django/django

echo "==> swebench lite for killer demo"
mkdir -p data/swebench
pnpm swebench --repo django/django > data/swebench/lite.jsonl || true

API_PUBLIC="${PUBLIC_IP:+http://$PUBLIC_IP/api}"
export NEXT_PUBLIC_LUMOS_API="${API_PUBLIC:-http://127.0.0.1:8787}"

echo "==> build web"
pnpm --filter web build

echo "==> nginx"
sudo apt-get install -y nginx
sudo tee /etc/nginx/sites-available/lumos >/dev/null <<NGINX
server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name _;

  location /api/ {
    rewrite ^/api/(.*)\$ /\$1 break;
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
  }

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
NGINX
sudo ln -sf /etc/nginx/sites-available/lumos /etc/nginx/sites-enabled/lumos
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

echo "==> systemd units"
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
Environment=NEXT_PUBLIC_LUMOS_API=http://${PUBLIC_IP:-127.0.0.1}/api
Environment=PORT=3000
ExecStart=$APP_DIR/node_modules/.bin/next start -p 3000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now lumos-api lumos-web

echo "deploy-ok  http://${PUBLIC_IP:-localhost}/"
