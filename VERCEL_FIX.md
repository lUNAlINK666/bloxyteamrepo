# Как исправить регистрацию на Vercel

## Проблема
Регистрация падает с ошибкой `FUNCTION_INVOCATION_FAILED` на production (Vercel), потому что не установлена переменная окружения `REDIS_URL`.

## Решение

### Вариант 1: Через Vercel Dashboard (проще)
1. Открой https://vercel.com/ngamersyts-projects/hyperfoxchat/settings/environment-variables
2. Добавь новую переменную:
   - **Key**: `HFC_REDIS_URL`
   - **Value**: `redis://default:IR13FULeyFN3FJlo543vuRF5wJVsSweK@microsweet-guitar-tame-25368.db.redis.io:17194`
   - **Environments**: выбери `Production`, `Preview`, `Development`
3. Нажми **Save**
4. Redeploy последний коммит

### Вариант 2: Через Vercel CLI
```bash
vercel env add HFC_REDIS_URL
# Вставь: redis://default:IR13FULeyFN3FJlo543vuRF5wJVsSweK@microsweet-guitar-tame-25368.db.redis.io:17194
# Выбери: Production, Preview, Development

# Затем redeploy:
vercel --prod
```

## Что исправлено в коде
1. ✅ Форма регистрации теперь использует `/api/site?action=login` с `action: "register"`
2. ✅ Этот эндпоинт возвращает токен сессии
3. ✅ После регистрации пользователь автоматически залогинен
4. ✅ Добавлено логирование ошибок Redis

## Проверка после исправления
После добавления переменной на Vercel, протестируй:
```bash
curl -X POST "https://hyperfoxchat.vercel.app/api/site?action=login" \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","password":"pass1234","action":"register"}'
```

Должен вернуть:
```json
{
  "ok": true,
  "action": "register",
  "token": "...",
  "username": "testuser",
  "uid": "1",
  ...
}
```
