# velocity-server

HTTP API для подписок читов velocity-cs2. Деплой: **Vercel** (serverless, Node.js).

Сервер хранит пару `username → expiresAtMs` и отдаёт, сколько дней осталось до конца подписки.

## Структура

```
server/
  api/
    status.js    GET  /api/status?username=X   — статус юзера (публичный, для чита)
    register.js  POST /api/register           — создать/продлить подписку (токен)
    users.js     GET  /api/users              — список всех юзеров (токен)
  lib/
    store.js     хранилище (Vercel KV или локальный JSON)
  dev.js         локальный дев-сервер
  vercel.json    конфиг Vercel
```

## Хранилище

- **Vercel KV** — если заданы `KV_REST_API_URL` и `KV_REST_API_TOKEN`. При подключении KV в дашборде Vercel переменные прокидываются автоматически.
- **Локальный файл** `server/data/db.json` — если KV не задан (для теста).

## Локальный запуск

```powershell
$env:ADMIN_TOKEN="secret"
npm run dev
```

Проверка:

```powershell
# создать юзера на 30 дней
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/register" `
  -Headers @{ "x-admin-token" = "secret" } `
  -ContentType "application/json" `
  -Body '{"username":"test","days":30}'

# статус
Invoke-RestMethod -Uri "http://localhost:3000/api/status?username=test"
```

## Деплой на Vercel

1. Установи CLI: `npm i -g vercel`
2. Создай в дашборде Vercel проект, подключи **KV (Upstash Redis)** к проекту — `KV_REST_API_*` подтянутся сами.
3. Добавь env-переменную `ADMIN_TOKEN` (секретный токен) в дашборде (Settings → Environment Variables).
4. Из папки:
   ```powershell
   cd server
   vercel
   ```
5. Получишь URL вида `https://velocity-server.vercel.app`.

Без KV на Vercel данные могут теряться при перезахолодке функции — KV (или хранилище) обязателен.

## API

| Метод | Путь | Токен | Описание |
|-------|------|-------|----------|
| GET | `/api/status?username=X` | нет | `{ ok, username, active, expiresAtMs, expiresAtIso }` |
| POST | `/api/register` | да | `{ username, days }` → создаёт/продлевает |
| GET | `/api/users` | да | список всех юзеров |

Токен передаётся в заголовке `x-admin-token: <ADMIN_TOKEN>` или `Authorization: Bearer <ADMIN_TOKEN>`.# Fixed registration - Tue Oct 27 12:31:08 RTZ 2026
# Updated 1793087084
# Deploy 1793087533
