# OneDay

Планировщик дня с голосовым помощником: задачи на неделю, регулярные дела, проекты.

Один файл `index.html` + Supabase (вход и база) + Vercel (хостинг и `/api/sample` — помощник Claude).
Пока `config.js` пустой, приложение работает без входа и хранит данные только на устройстве.

**Быстрый старт**
1. Supabase: создать проект, выполнить `supabase/migrations/20261023000000_init.sql` в SQL Editor.
   Скопировать Project URL и publishable-ключ в `config.js`.
2. Vercel: импортировать этот репозиторий, добавить переменные `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`.
3. Supabase → Authentication → URL Configuration: указать адрес сайта с Vercel (Site URL и Redirect URLs `https://адрес/**`).
   Для входа через Google — включить провайдера Google в Authentication → Providers.

**Проверка:** `cd tests && npm install && npm test` (база: `npm run test:db`, нужен `brew install postgresql@16`)

Подробные правила работы — в `CLAUDE.md`.
