# Cloud Production Deploy Guide (VPS)

Deploy SignChat on a cloud VPS with **`next build/start`** + **Caddy** for TLS (HTTPS + WSS) + **coturn** for TURN relay.

## Architecture

```
  Internet
     │
   :443  Caddy (auto TLS / Let's Encrypt)
     ├── /            → localhost:3000  (next start)
     ├── /ws/*        → localhost:8001  (daphne WSS)
     └── /api/*       → localhost:8001  (daphne HTTPS)
     │
   :3478  coturn (TURN relay)
   :49152-49252  coturn (RTP media)
```

All traffic goes through a **single domain** on port 443 — no need for clients to
know about port 3000 or 8001.

---

## Prerequisites

- Ubuntu 22.04+ VPS with a **public IP**
- A **domain** pointing to this IP (e.g. `signchat.example.com`)
  - Or use IP-only with self-signed cert (clients must trust CA)
- Docker & Docker Compose installed
- Node.js 18+ installed
- [Caddy 2](https://caddyserver.com/docs/install) installed

---

## Step-by-step

### 1. Clone & set env vars

```bash
git clone <repo-url> && cd signchat

export PUBLIC_IP=$(curl -s ifconfig.me)
export DOMAIN="signchat.example.com"    # or $PUBLIC_IP if no domain
export TURN_EXTERNAL_IP=$PUBLIC_IP
export LAN_IP=$PUBLIC_IP
export TURN_PASS=$(openssl rand -hex 16)

echo "PUBLIC_IP=$PUBLIC_IP"
echo "TURN_PASS=$TURN_PASS"
```

### 2. Firewall

```bash
ufw allow 80/tcp        # Caddy HTTP → HTTPS redirect
ufw allow 443/tcp       # Caddy HTTPS
ufw allow 3478/udp      # TURN
ufw allow 3478/tcp      # TURN
ufw allow 49152:49252/udp  # TURN relay
```

### 3. Start Docker services

```bash
docker compose up -d postgres redis backend backend_tls turn
```

Verify:

```bash
docker compose ps              # all running
curl -sk https://localhost:8001/health/   # 200 OK (backend_tls)
lsof -nP -iUDP:3478           # coturn listening
```

### 4. Build & start frontend

```bash
cd frontend && npm ci

cat > .env.local << EOF
NEXT_PUBLIC_ICE_SERVERS='[{"urls":["stun:stun.l.google.com:19302"]},{"urls":["turn:${PUBLIC_IP}:3478?transport=udp","turn:${PUBLIC_IP}:3478?transport=tcp"],"username":"signchat","credential":"${TURN_PASS}"}]'
EOF

npm run build
PORT=3000 npm start &
```

Verify: `curl -s http://localhost:3000/ | head -5`

### 5. Caddy config

```bash
cat > /etc/caddy/Caddyfile << CADDY
${DOMAIN} {
    # Frontend (Next.js production)
    reverse_proxy localhost:3000

    # Backend — WebSocket + API
    handle_path /ws/* {
        reverse_proxy localhost:8001
    }
    handle_path /api/* {
        reverse_proxy localhost:8001
    }
    handle_path /health/* {
        reverse_proxy localhost:8001
    }
}
CADDY

sudo systemctl reload caddy
```

Caddy auto-obtains a Let's Encrypt certificate for your domain.

### 6. Smoke test

```bash
# From any network (phone, another machine, etc.)
curl -s https://${DOMAIN}/match | head -5     # HTML
curl -sk https://${DOMAIN}/health/            # 200 (proxied to backend)
```

---

## IP-only (no domain, self-signed)

If no domain is available, use mkcert:

```bash
mkcert -install
mkcert -cert-file ~/certs/dev.pem -key-file ~/certs/dev-key.pem \
  $PUBLIC_IP localhost 127.0.0.1
```

Run `next dev` with HTTPS (instead of Caddy):

```bash
NEXT_PUBLIC_ICE_SERVERS='...' npm run dev -- \
  --hostname 0.0.0.0 --port 3000 \
  --experimental-https \
  --experimental-https-key ~/certs/dev-key.pem \
  --experimental-https-cert ~/certs/dev.pem
```

Clients must install the mkcert root CA (`rootCA.pem`) on their devices.

---

## Frontend WebSocket URL note

With Caddy proxying `/ws/*` on port 443, the frontend's `useMatchSocket` may need
to construct the WSS URL as `wss://${DOMAIN}/ws/match/` instead of
`wss://${HOST}:8001/ws/match/`. If your `getWsUrl()` logic builds the URL from
`window.location`, this should work automatically when accessed via `https://${DOMAIN}`.

If not, set a custom env var (e.g. `NEXT_PUBLIC_WS_BASE`) to override.

---

## Verification Checklist

| Check | Command | Expected |
|-------|---------|----------|
| Page loads (any network) | `curl https://${DOMAIN}/match` | HTML |
| Health endpoint | `curl https://${DOMAIN}/health/` | `{"status":"ok"}` |
| Backend logs clean | `docker compose logs backend_tls --tail=20` | No errors |
| TURN alive | `docker compose logs turn --tail=10` | Listening messages |
| Relay candidate | Debug panel on `/match` | `relay <IP>:port udp` |
| Selected pair (cross-net) | Debug panel | `relay/... → relay/...` |
| Traffic in coturn | `docker compose logs -f turn` | `traffic between` lines |
