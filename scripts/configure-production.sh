#!/usr/bin/env bash
# Configure nginx as Lumos's only public entry point.
set -euo pipefail

DOMAIN="${DOMAIN:-lumos.uno}"
APP_HOST="${APP_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-8787}"
WEB_PORT="${WEB_PORT:-3000}"
CERT_DIR="/etc/letsencrypt/live/$DOMAIN"

sudo tee /etc/nginx/conf.d/lumos-security.conf >/dev/null <<'NGINX'
server_tokens off;
# UI polls ~6 endpoints and demo open fires a short burst on top; 60r/m was too tight.
limit_req_zone $binary_remote_addr zone=lumos_api:10m rate=180r/m;
limit_req_zone $binary_remote_addr zone=lumos_import:10m rate=3r/m;
limit_conn_zone $binary_remote_addr zone=lumos_connections:10m;
NGINX

proxy_locations() {
  cat <<NGINX
  client_max_body_size 256k;
  limit_req_status 429;
  limit_conn_status 429;
  error_page 429 = @api_rate_limited;

  location @api_rate_limited {
    default_type application/json;
    add_header Content-Type application/json always;
    return 429 '{"error":"Too many requests. Wait a moment and try again."}';
  }

  location = /api/repositories/import {
    limit_req zone=lumos_import burst=1 nodelay;
    limit_conn lumos_connections 4;
    rewrite ^/api/(.*)\$ /\$1 break;
    proxy_pass http://${APP_HOST}:${API_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
  }

  location /api/ {
    limit_req zone=lumos_api burst=40 nodelay;
    limit_conn lumos_connections 12;
    rewrite ^/api/(.*)\$ /\$1 break;
    proxy_pass http://${APP_HOST}:${API_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
  }

  location / {
    proxy_pass http://${APP_HOST}:${WEB_PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
  }
NGINX
}

if sudo test -f "$CERT_DIR/fullchain.pem"; then
  {
    cat <<NGINX
server {
  listen 443 ssl http2;
  listen [::]:443 ssl http2;
  server_name $DOMAIN;

  ssl_certificate $CERT_DIR/fullchain.pem;
  ssl_certificate_key $CERT_DIR/privkey.pem;
  include /etc/letsencrypt/options-ssl-nginx.conf;
  ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

  add_header Strict-Transport-Security "max-age=31536000" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header X-Frame-Options "DENY" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
  add_header Content-Security-Policy "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" always;
NGINX
    proxy_locations
    cat <<NGINX
}

server {
  listen 443 ssl http2;
  listen [::]:443 ssl http2;
  server_name www.$DOMAIN;
  ssl_certificate $CERT_DIR/fullchain.pem;
  ssl_certificate_key $CERT_DIR/privkey.pem;
  include /etc/letsencrypt/options-ssl-nginx.conf;
  ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
  return 301 https://$DOMAIN\$request_uri;
}

server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name $DOMAIN www.$DOMAIN;
  return 301 https://$DOMAIN\$request_uri;
}
NGINX
  } | sudo tee /etc/nginx/sites-available/lumos >/dev/null
else
  {
    cat <<NGINX
server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name $DOMAIN www.$DOMAIN;
NGINX
    proxy_locations
    echo "}"
  } | sudo tee /etc/nginx/sites-available/lumos >/dev/null
  echo "TLS certificate not found. Run: sudo certbot --nginx -d $DOMAIN -d www.$DOMAIN"
fi

sudo ln -sf /etc/nginx/sites-available/lumos /etc/nginx/sites-enabled/lumos
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl enable nginx
sudo systemctl reload nginx

