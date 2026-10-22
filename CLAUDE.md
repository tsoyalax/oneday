# OneDay — правила проекта

Веб-приложение «OneDay» — планировщик дня с голосовым помощником (один файл `index.html`, без сборки).
Изначально артефакт на claude.ai: https://claude.ai/artifact/Vrt4KaN18JvTn8gEyQ5CXX.
Данные и вход — Supabase, хостинг и серверная функция — Vercel, код и история — GitHub (`tsoyalax/oneday`).
Пользователь не программист: объясняй простыми словами, действуй шагами, перед необратимыми действиями спрашивай.

## Структура
- `index.html` — всё приложение (интерфейс и логика). Правим точечно, не переписываем целиком.
  В `<head>` подключены supabase-js (точная версия), `config.js` и `claude-shim.js` — раньше кода приложения.
- `claude-shim.js` — «переходник»: приложение вызывает `window.claude.use('user' | 'db' | 'sample')`,
  а файл превращает это в запросы к Supabase и к `/api/sample`. Экран входа (только почта и пароль; Google убран по решению пользователя) тоже здесь.
  Пустой `config.js` → переходник не включается, приложение работает локально (`syncInit` ставит статус `local`).
- `config.js` — публичный адрес Supabase и publishable-ключ (их можно коммитить).
- `api/sample.js` — серверная функция Vercel: прокси к ИИ для помощника. Задан `GEMINI_API_KEY` → Gemini
  (`gemini-3.6-flash`, быстрая `gemini-3.5-flash-lite`, generateContent API), иначе Claude (`ANTHROPIC_API_KEY`). Проверяет вход и лимиты.
- `supabase/migrations/` — изменения базы. Таблица `docs`, пути только `data/users/<id>/…`.
- `tests/` — автотесты (`cd tests && npm install && npm test`). Права и миграции: `npm run test:db` (нужен локальный Postgres).

## Как приложение хранит данные
- На устройстве: `localStorage` `journal-ai-v2` (всё состояние), `journal-ai-sync-ts` (метка последней синхронизации),
  `journal-font`, `journal-pal` (вид).
- В аккаунте: один документ `data/users/<id>/state` = `{ data: JSON-строка состояния, updated: метка }`.
  При запуске (`syncInit`) берётся более свежая копия; правки отправляются через 1,2 с (`schedulePush` → `pushNow`).
  Больше 230 КБ — очищается журнал помощника `state.memory.log`.
- Выход: `window.odSignOut()` стирает `journal-ai*` на устройстве (кнопки выхода в интерфейсе пока нет).

## Железные правила
1. **Секреты не коммитим.** Нельзя в код, чат и логи: `sb_secret_…`, `service_role`, пароль базы,
   `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, токены. Они лежат в Vercel (Environment Variables). `.env` в `.gitignore`.
2. **Миграции только вперёд.** Применённый файл в `supabase/migrations/` не правим и не удаляем. Любое изменение базы —
   новый файл `YYYYMMDDHHMMSS_название.sql`, переживающий повторный запуск. Опасные операции (`drop`, `delete`, `truncate`) — только после явного «да».
3. **Права доступа:** каждый видит и меняет только `data/users/<свой id>/…`; запись только через `doc_set / doc_update / doc_delete`.
   После правки прав — прогнать `npm run test:db`.
4. **Перед пушем** запускаем `tests`. Красные тесты не пушим.
5. **Работаем в ветке**, в `main` — только после проверки на preview-ссылке Vercel. Коммиты короткие, по-русски, по делу.
6. Не добавляем сторонние библиотеки и CDN без необходимости. Скрипты подключаем с точной версией.

## Git и SSH
- Отдельный ключ `~/.ssh/id_ed25519_oneday`, хост-псевдоним `github-oneday` в `~/.ssh/config`.
  Адрес репозитория: `git@github-oneday:tsoyalax/oneday.git` (ключ добавлен в репозиторий как deploy key с записью).

## Переменные окружения Vercel
`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` и ключ ИИ: `GEMINI_API_KEY` (сейчас используется) или `ANTHROPIC_API_KEY`.
Необязательно: `GEMINI_MODEL`, `GEMINI_MODEL_FAST`, `ANTHROPIC_MODEL`, `ANTHROPIC_MODEL_FAST`.
