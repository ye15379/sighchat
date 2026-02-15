# signchat MVP

## Backend (Django)

Run with Docker:

```bash
docker compose up --build
```

Health check:

- `http://localhost:8000/health/`

## Frontend (Next.js)

在 `frontend/` 下启动：

```bash
cd frontend
npm install
npm run dev
```

Frontend default:

- `http://localhost:3000`

---

## ✅ 本地验收方式

在项目根目录运行：

```bash
docker compose up --build
```

看到 backend 运行后，打开：

- `http://localhost:8000/health/`

期望返回：

```json
{"status":"ok"}
```

