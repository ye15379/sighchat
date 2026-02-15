# WebRTC Connectivity — STUN / TURN

## 1. Three Layers of Reachability

A WebRTC call requires **three** services reachable by **both** peers:

| Layer | Service | Port (dev) | Protocol |
|-------|---------|-----------|----------|
| Web page | Next.js frontend | 3000 | HTTPS |
| Signaling | Daphne backend\_tls | 8001 | WSS |
| Media relay | coturn | 3478 + 49152–49252 | UDP + TCP |

> **TURN only solves the media layer.** If the iPhone cannot load the page
> (3000) or connect the WebSocket (8001), the call never starts.

```
  Peer A (Mac)                                          Peer B (iPhone)
    ├── HTTPS  :3000 ◄──── both must reach ────► :3000
    ├── WSS    :8001 ◄──── both must reach ────► :8001
    └── TURN   :3478 ◄──── both must reach ────► :3478
```

> **LAN IPs (192.168.x.x) are NOT reachable from cellular.**
> Use Tailscale VPN (Golden Path A) or a cloud VPS (Golden Path B).

---

## 2. Coturn Reference

`docker-compose.yml` runs **coturn 4.6** as the `turn` service.

### `TURN_EXTERNAL_IP` (required env var)

The IP coturn embeds in relay candidates. Must be routable by **both** peers.

| Deployment | Value | Example |
|------------|-------|---------|
| LAN-only | Wi-Fi IP | `192.168.1.42` |
| Tailscale | Tailscale IP | `100.64.0.7` |
| Cloud VPS | Public IP | `203.0.113.10` |
| Cloud behind NAT | `PUBLIC/PRIVATE` | `203.0.113.10/10.0.0.5` |

### Other env vars

| Variable | Default | Notes |
|----------|---------|-------|
| `TURN_USER` | `signchat` | Must match `username` in `NEXT_PUBLIC_ICE_SERVERS` |
| `TURN_PASS` | `signchat` | Must match `credential` — dev only, change for production |
| `TURN_REALM` | `signchat.local` | |

---

## 3. Golden Path A — Tailscale VPN (one-click cross-network)

**Topology:** All services on your Mac. iPhone on cellular connects via Tailscale mesh VPN.

### Prerequisites

| Item | How to check |
|------|-------------|
| Tailscale on Mac | `tailscale ip -4` → `100.x.y.z` |
| Tailscale on iPhone | Settings → VPN → Tailscale → Connected |
| Both on same Tailnet | Tailscale admin console shows both devices |
| mkcert installed | `mkcert --version` |
| Docker running | `docker compose version` |

### One command

```bash
./frontend/scripts/dev-clean-start-tailscale-https.sh
```

This script does **everything** automatically:

1. Detects Tailscale IPv4 (or reads `TAILSCALE_IP` env)
2. Raises `ulimit -n` to 10240 if needed
3. Kills stale `:3000` listeners
4. Generates mkcert cert covering `localhost + 127.0.0.1 + ::1 + <TS_IP>` (skips if already valid)
5. Starts `backend_tls` + `turn` via `docker compose`
6. Writes `frontend/.env.local` with correct `NEXT_PUBLIC_ICE_SERVERS`
7. Starts Next.js HTTPS on `0.0.0.0:3000`
8. Probes all three layers and prints a status table
9. Prints access URLs and validation checklist

If Tailscale is not installed, you can set the IP manually:

```bash
export TAILSCALE_IP=100.64.0.7
./frontend/scripts/dev-clean-start-tailscale-https.sh
```

### Access URLs (printed by the script)

| Device | URL |
|--------|-----|
| Mac (local) | `https://localhost:3000/match` |
| iPhone (cellular + Tailscale VPN) | `https://<TS_IP>:3000/match` |

### iPhone: trusting the mkcert certificate

Safari will show a "connection is not private" warning on first visit. Two options:

**Option 1 — Quick bypass (per session):**

1. Safari → "Show Details" → "visit this website" → confirm

**Option 2 — Full trust (permanent):**

1. On Mac, find the root CA:

```bash
ls ~/Library/Application\ Support/mkcert/rootCA.pem
```

2. AirDrop `rootCA.pem` to iPhone
3. iPhone: Settings → General → VPN & Device Management → "mkcert ..." → Install
4. iPhone: Settings → General → About → Certificate Trust Settings → toggle ON for mkcert

After this, Safari will show a green lock for all mkcert-signed sites.

### Preflight check (from iPhone / any Tailscale peer)

```bash
TS=100.64.0.7  # your Tailscale IP

curl -sk https://$TS:3000/        # → HTML
curl -sk https://$TS:8001/health/ # → {"status":"ok"}
nc -z -w3 $TS 3478               # → open (TURN TCP)
```

All three must succeed. If any times out, fix before testing WebRTC.

### Validation checklist

After both peers open `/match`:

- [ ] `https://localhost:3000/match` loads on Mac
- [ ] `https://<TS_IP>:3000/match` loads on iPhone (Tailscale VPN on, cellular)
- [ ] Both click "Find Random" → matched to same `room_id`
- [ ] Debug panel → `iceConnectionState` = `connected`
- [ ] Debug panel → `selectedCandidatePair` contains `relay` (proves TURN in use)
- [ ] `docker compose logs -f turn` shows `traffic between ... and ...`

### Common failures

| Symptom | Check command | Fix |
|---------|---------------|-----|
| iPhone can't load page at all | `curl -sk https://<TS_IP>:3000/` from iPhone | Tailscale VPN not connected; enable it |
| `ERR_CERT_AUTHORITY_INVALID` on iPhone | — | Trust mkcert CA (see above) or tap "Advanced → Proceed" |
| Page loads but "WebSocket error" | `curl -sk https://<TS_IP>:8001/health/` | backend\_tls not running or cert doesn't cover TS IP |
| WS connects but no video | `docker compose logs turn --tail=20` | coturn not running or `TURN_EXTERNAL_IP` wrong |
| `relay` candidate but `checking` stuck | `lsof -nP -iUDP:49152` | UDP relay port range not exposed — check docker-compose ports |
| `getUserMedia requires HTTPS` | browser console | Accessing via HTTP, not HTTPS — use the script |
| Script fails "tailscale ip -4 empty" | `tailscale status` | Run `tailscale up` first |
| Script fails "mkcert not found" | `mkcert --version` | `brew install mkcert && mkcert -install` |
| backend\_tls unhealthy | `docker compose logs backend_tls --tail=30` | Missing certs in `~/certs/` or DB not migrated |
| coturn not listening on :3478 | `lsof -nP -iTCP:3478 -sTCP:LISTEN` | `TURN_EXTERNAL_IP` not set; re-run the script |

---

## 4. Golden Path B — Full-stack on Cloud VPS (production-isomorphic)

**Topology:** Everything on a VPS with a public IP. No VPN needed.

> Uses `next build` + `next start` (not `next dev`) and a reverse proxy
> (Caddy) for TLS. This matches real production.

### VPS setup (Ubuntu 22.04+)

```bash
# ── 1. Clone & env ──
git clone <repo> && cd signchat
export PUBLIC_IP=$(curl -s ifconfig.me)
export TURN_EXTERNAL_IP=$PUBLIC_IP
export LAN_IP=$PUBLIC_IP
export TURN_PASS=$(openssl rand -hex 16)

# ── 2. Firewall ──
ufw allow 80/tcp       # Caddy redirect
ufw allow 443/tcp      # Caddy HTTPS
ufw allow 3478/udp     # TURN
ufw allow 3478/tcp
ufw allow 49152:49252/udp

# ── 3. Docker services ──
docker compose up -d postgres redis backend backend_tls turn

# ── 4. Build frontend ──
cd frontend && npm ci
cat > .env.local << EOF
NEXT_PUBLIC_ICE_SERVERS='[{"urls":["stun:stun.l.google.com:19302"]},{"urls":["turn:${PUBLIC_IP}:3478?transport=udp","turn:${PUBLIC_IP}:3478?transport=tcp"],"username":"signchat","credential":"${TURN_PASS}"}]'
EOF
npm run build
PORT=3000 npm start &

# ── 5. Caddy (auto-TLS) ──
cat > /etc/caddy/Caddyfile << 'CADDY'
signchat.example.com {
    reverse_proxy localhost:3000
    handle /ws/* {
        reverse_proxy localhost:8001
    }
}
CADDY
sudo systemctl reload caddy
```

### Access URLs

- Any device: `https://signchat.example.com/match`

### Smoke test

```bash
curl -s https://signchat.example.com/match | head -5   # HTML
curl -s https://signchat.example.com/health/            # 200
```

### Without a domain (self-signed, IP-only)

```bash
mkcert -install
mkcert -cert-file ~/certs/dev.pem -key-file ~/certs/dev-key.pem \
  $PUBLIC_IP localhost 127.0.0.1

npm run dev -- --hostname 0.0.0.0 --port 3000 \
  --experimental-https \
  --experimental-https-key ~/certs/dev-key.pem \
  --experimental-https-cert ~/certs/dev.pem
```

Clients must trust the mkcert root CA.

---

## 5. Reachability Check (generic)

Run **from the remote peer's network**:

```bash
HOST=100.64.0.7  # Tailscale IP, public IP, or domain

echo "── Frontend ──"
curl -sk --max-time 5 -o /dev/null -w "https://$HOST:3000 → %{http_code}\n" "https://$HOST:3000/"

echo "── Backend ──"
curl -sk --max-time 5 -o /dev/null -w "https://$HOST:8001 → %{http_code}\n" "https://$HOST:8001/health/"

echo "── TURN ──"
nc -z -w3 "$HOST" 3478 && echo "$HOST:3478 → OPEN" || echo "$HOST:3478 → CLOSED"
```

All three must pass. If any times out → fix network first.

---

## 6. Confirming TURN relay is active

1. **Debug panel** (bottom of `/match` page):
   - `lastIceCandidateSummary` → `relay <IP>:<port> udp`
   - `selectedCandidatePair` → `relay/... -> relay/...`
   - `iceConnectionState` → `connected`

2. **Coturn logs:**

```bash
docker compose logs -f turn
# Success: "session ... : usage(...)  traffic between ... and ..."
```

3. **Local port check:**

```bash
lsof -nP -iTCP:3478 -sTCP:LISTEN   # coturn TCP
lsof -nP -iUDP:3478                 # coturn UDP
docker compose ps turn              # container running?
```

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| iPhone can't load page | :3000 unreachable from cellular | Use VPN (Path A) or public IP (Path B) |
| Page loads, "WebSocket error" | :8001 unreachable | Expose 8001 or use Caddy proxy |
| WS OK, no video, no `relay` | TURN unreachable / bad creds | Check logs, verify IP/port/user/pass |
| `relay` gathered, `checking` stuck | UDP 49152–49252 blocked | Open ports in firewall |
| `external-ip` wrong | Wrong `TURN_EXTERNAL_IP` | Must be reachable by both peers |
| `TURN_EXTERNAL_IP` error on compose | Env not set | `export TURN_EXTERNAL_IP=...` |
| Works LAN, fails cellular | Using 192.168.x.x | Not routable; use Path A or B |
| `getUserMedia requires HTTPS` | Plain HTTP | Use HTTPS script |
| Coturn `403` | Wrong realm/nonce | Restart coturn |

---

## 8. `buildIceServers()` (frontend code — do not modify)

`frontend/lib/useRoomRtc.ts` reads `NEXT_PUBLIC_ICE_SERVERS` at compile time.
Invalid/empty → fallback to Google STUN + Twilio STUN.

**Restart dev server after changing `.env.local`** — env is baked at build time.

---

## 9. Dev Commands

```bash
cd frontend
npm run lint       # ESLint
npx tsc --noEmit   # TypeScript
```
