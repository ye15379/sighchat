# SignChat — Project Context (Single Source of Truth)

> **Purpose:** Give any AI assistant (ChatGPT, Claude, Cursor, etc.) enough
> context to make accurate changes without lengthy preamble. Copy-paste or
> `@`-reference this file at the start of a session.
>
> Last updated: 2026-02-25

---

## 1. Architecture Overview

```
signchat/                          ← monorepo root
├── backend/                       ← Django 5 + DRF + Channels (ASGI via Daphne)
│   ├── core/                      ← Django project (settings, asgi, urls)
│   ├── api/                       ← REST endpoints (health, session/init)
│   ├── realtime/                  ← Channels consumers (EchoConsumer, MatchConsumer)
│   └── Dockerfile
├── frontend/                      ← Next.js 14 (App Router, TypeScript)
│   ├── app/match/page.tsx         ← Main product page
│   ├── lib/useMatchSocket.ts      ← WebSocket hook (matchmaking + chat)
│   ├── lib/useRoomRtc.ts          ← WebRTC hook (media, signaling, ICE)
│   ├── components/VideoCallPanel  ← Video UI (big=remote, small=local)
│   └── scripts/                   ← Dev startup scripts
├── scripts/
│   └── dev-env.sh                 ← Auto-generate .env + frontend/.env.local
├── docs/
│   ├── PROJECT_CONTEXT.md         ← THIS FILE
│   ├── webrtc-connectivity.md     ← STUN/TURN/Golden Paths
│   └── (frontend/docs/webrtc-debug.md)
├── docker-compose.yml
└── .github/workflows/main.yml
```

---

## 2. Services & Ports

| Service | Container | Port | Protocol | Notes |
|---------|-----------|------|----------|-------|
| **Postgres 16** | `signchat_postgres` | 5432 | TCP | DB: `signchat` / user: `signchat` |
| **Redis 7** | `signchat_redis` | 6379 | TCP | Channel layer backend |
| **Backend (HTTP)** | `signchat_backend` | 8000 | HTTP | Daphne ASGI; `/health/`, `/api/session/init` |
| **Backend (TLS)** | `signchat_backend_tls` | 8001 | HTTPS/WSS | Daphne + SSL; requires `~/certs/dev.pem` |
| **Frontend** | _(local process)_ | 3000 | HTTPS | `next dev --experimental-https` |
| **Coturn (TURN)** | `signchat_turn` | 3478 + 49152–49252 | UDP/TCP | Profile `webrtc`; requires `TURN_EXTERNAL_IP` |

### Docker Compose profiles

- **Default** (`docker compose up -d`): postgres, redis, backend, backend_tls
- **webrtc** (`docker compose --profile webrtc up -d turn`): adds coturn

---

## 3. Key Environment Variables

| Variable | Where set | Consumed by |
|----------|-----------|-------------|
| `TURN_EXTERNAL_IP` | `.env` (root) | `docker-compose.yml` → coturn `--external-ip` |
| `NEXT_PUBLIC_ICE_SERVERS` | `frontend/.env.local` | `useRoomRtc.ts` → `buildIceServers()` |
| `LAN_IP` | Shell export / compose env | backend `ALLOWED_HOSTS`, cert SAN |

Both `.env` and `frontend/.env.local` are **git-ignored** and auto-generated
by `scripts/dev-env.sh`.

---

## 4. WebRTC Signaling Flow

```
A (caller)                    Server                    B (callee)
    │  ws connect /ws/match/?token=...                      │
    │──── {type:"find", mode:"region"} ────►                │
    │                                   ◄──── {type:"find"} │
    │◄──── {type:"matched", room_id} ──────────────────────►│
    │                                                       │
    │  ── hello ─────────────────────────────► hello ──     │
    │  (caller election: lexicographic clientId compare)    │
    │                                                       │
    │  ── offer (SDP) ─────────────────────►                │
    │                        ◄── answer (SDP) ──            │
    │  ◄─── ICE candidates ────────────────►                │
    │               ... media flows (P2P or via TURN) ...   │
```

Signaling is carried over WebSocket as `rtc_signal` messages inside the
matched room's channel-layer group. The `MatchConsumer` broadcasts them.

---

## 5. Known Issues & Fixes (Safari / WebRTC)

### 5a. Safari big-screen black: duplicate m-lines (2 audio + 2 video)

**Root cause:** `pc.addTrack()` + `pc.addTransceiver()` both ran in `autoStart`,
producing 4 m-lines. Safari cannot render a `<video>` with 2 video tracks.

**Fix (useRoomRtc.ts):**
- Send side: only `addTransceiver` + `sender.replaceTrack()`. No `addTrack()`.
- Receive side: `bindRemoteVideo()` filters to at most 1 video + 1 audio track.
- `ontrack` fallback: dedup by `track.id` to prevent accumulation.

### 5b. Safari big-screen black: remoteTrackReceived=false

**Root cause:** Callee `createAnswer` before `replaceTrack` completed →
answer SDP has `recvonly` m-lines → caller never receives remote tracks.

**Fix (useRoomRtc.ts):**
- Promise-based `localReady` gate: `markLocalReady()` after `replaceTrack`.
- Drain offer branch: `await waitLocalReady(12000)` before `setRemoteDescription`.
- `resetLocalReady()` in cleanup resolves pending waiters (no hanging promises).

### 5c. Safari big-screen hasSrcObject=false after re-render

**Root cause:** `ontrack` fires before React commits the `<video>` ref.

**Fix (useRoomRtc.ts):**
- `remoteStreamVersion` state counter bumped in `ontrack`.
- `useEffect([remoteStreamVersion])` calls `bindRemoteVideo("stream-effect")`
  after React commit — refs are guaranteed set.
- Stable `useCallback` ref setters (`setRemoteVideoEl`, `setLocalVideoEl`).

### Diagnostic script (browser console)

```js
[...document.querySelectorAll("video")].map(v => ({
  hasSrcObject: !!v.srcObject,
  readyState: v.readyState,
  w: v.videoWidth, h: v.videoHeight,
  tracks: v.srcObject?.getTracks().map(t => ({kind:t.kind, rs:t.readyState})) ?? null
}))
```

Expected: both videos `hasSrcObject: true`, big video `w > 0, h > 0`.

---

## 6. CI / GitHub Actions

**Workflow:** `.github/workflows/main.yml`

```yaml
jobs:
  docker-build:
    steps:
      - docker compose build
      - docker compose up -d postgres redis backend
      - healthcheck: curl http://localhost:8000/health/
      - docker compose down -v --remove-orphans
```

- Runs on every push and PR.
- Does **not** start `turn` (profile `webrtc` not activated).
- Does **not** need `TURN_EXTERNAL_IP`.
- `backend/.env.example` and `frontend/.env.example` are tracked (un-ignored
  via `!.env.example` in `.gitignore`).

---

## 7. Local Dev — Quick Start

### Routine (no TURN)

```bash
docker compose up -d --build
cd frontend && npm run dev
# → http://localhost:3000/match  (HTTP, same-machine only)
```

### HTTPS + TURN (cross-device / Safari)

```bash
./frontend/scripts/dev-clean-start-https.sh
# Automatically:
#   1. runs scripts/dev-env.sh → generates .env + frontend/.env.local
#   2. ulimit, port cleanup, mkcert cert generation
#   3. starts Next.js HTTPS on 0.0.0.0:3000
#   4. probes frontend/backend/turn reachability
```

### Start TURN separately

```bash
bash scripts/dev-env.sh                              # writes .env
docker compose --profile webrtc up -d turn           # starts coturn
```

---

## 8. Troubleshooting Commands

```bash
# ── Services ──
docker compose ps                                    # running containers
docker compose logs --tail=50 backend                # backend logs
docker compose logs --tail=50 turn                   # coturn logs

# ── Ports ──
lsof -nP -iTCP:3000 -sTCP:LISTEN                    # who owns :3000
lsof -nP -iTCP:8000 -sTCP:LISTEN                    # backend HTTP
lsof -nP -iTCP:8001 -sTCP:LISTEN                    # backend TLS
lsof -nP -iTCP:3478 -sTCP:LISTEN                    # coturn TCP
lsof -nP -iUDP:3478                                 # coturn UDP

# ── Network / reachability ──
curl -sk https://localhost:3000/match                # frontend
curl -sk https://localhost:8001/health/              # backend TLS
curl http://localhost:8000/health/                   # backend HTTP

# ── Frontend checks ──
cd frontend
npm run lint                                         # ESLint
npx tsc --noEmit                                     # TypeScript
```

---

## 9. Branch Protection & Git Conventions

- `main` branch is protected (no direct push; PRs required).
- Commit style: `type(scope): description`
  - `fix(rtc):`, `chore(dev):`, `chore(docs):`, `feat(match):`, etc.
- `.env` and `frontend/.env.local` are git-ignored; never commit secrets.
- `.env.example` files are tracked for CI and documentation.
