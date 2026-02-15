#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
if [ -z "$LAN_IP" ]; then
  echo "[backend-tls] ERROR: failed to detect LAN_IP from en0/en1"
  exit 1
fi
export LAN_IP

CERT_DIR="$HOME/certs"
CERT_FILE="$CERT_DIR/dev.pem"
KEY_FILE="$CERT_DIR/dev-key.pem"

echo "[backend-tls] LAN_IP: $LAN_IP"
echo "[backend-tls] cert: $CERT_FILE"
echo "[backend-tls] key:  $KEY_FILE"

if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; then
  echo "[backend-tls] cert missing, generating via mkcert"
  mkdir -p "$CERT_DIR"
  if ! command -v mkcert >/dev/null 2>&1; then
    echo "[backend-tls] ERROR: mkcert not found"
    exit 1
  fi
  if ! mkcert -install; then
    echo "[backend-tls] warning: mkcert -install failed, continue anyway"
  fi
  mkcert -cert-file "$HOME/certs/dev.pem" -key-file "$HOME/certs/dev-key.pem" localhost 127.0.0.1 ::1 "$LAN_IP"
fi

echo "[backend-tls] starting backend_tls..."
docker compose up -d --build backend_tls

echo "[backend-tls] waiting for TLS ready on https://${LAN_IP}:8001/ (up to 20s)..."
tls_ready=0
for _ in $(seq 1 20); do
  set +e
  health_code="$(curl -sk --max-time 3 -o /dev/null -w "%{http_code}" "https://${LAN_IP}:8001/health/")"
  health_rc=$?
  set -e
  if [ "$health_rc" -eq 0 ] && [ "$health_code" = "200" ]; then
    tls_ready=1
    break
  fi

  set +e
  root_code="$(curl -sk --max-time 3 -o /dev/null -w "%{http_code}" "https://${LAN_IP}:8001/")"
  root_rc=$?
  set -e
  if [ "$root_rc" -eq 0 ] && [ "$root_code" != "000" ]; then
    tls_ready=1
    break
  fi

  sleep 1
done

if [ "$tls_ready" -ne 1 ]; then
  echo "[backend-tls] ERROR: TLS probe failed after 20s on https://${LAN_IP}:8001/"
  echo "[backend-tls] docker compose ps:"
  docker compose ps || true
  echo "[backend-tls] docker compose logs backend_tls --tail=200:"
  docker compose logs backend_tls --tail=200 || true
  echo "[backend-tls] curl debug (handshake detail):"
  curl -vk "https://${LAN_IP}:8001/" --max-time 8 || true
  exit 1
fi

echo "[backend-tls] expected WSS URL: wss://${LAN_IP}:8001/ws/match/"
echo "[backend-tls] verify commands:"
echo 'A) LAN_IP="$(ipconfig getifaddr en0 || ipconfig getifaddr en1)"'
echo '   curl -vk "https://${LAN_IP}:8001/" --max-time 8'
echo 'B) 浏览器 Console（在 https://$LAN_IP:3000/match 打开 Console）'
echo '   const url = "PASTE_WSS_URL_FROM_PAGE_MESSAGES_HERE";'
echo '   const ws = new WebSocket(url);'
echo '   ws.onopen = () => console.log("WSS open ✅");'
echo '   ws.onerror = (e) => console.log("WSS error ❌", e);'
echo '   ws.onclose = (e) => console.log("WSS close", e.code, e.reason);'
echo 'C) 前端页面 Messages 验收'
echo '   - Messages / debug 输出里应出现：wss://$LAN_IP:8001/ws/match/?token=...'
echo '   - 且不再反复出现：WebSocket error / WebSocket disconnected'
