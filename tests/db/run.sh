#!/bin/sh
# Проверка миграций и прав доступа на временном локальном Postgres.
# Нужен PostgreSQL 15+ (на Mac: brew install postgresql@16). База создаётся и удаляется сама.
set -e
export LC_ALL=C LANG=C
cd "$(dirname "$0")"
PGBIN="${PGBIN:-$(ls -d /opt/homebrew/opt/postgresql@*/bin /usr/local/opt/postgresql@*/bin 2>/dev/null | tail -1)}"
[ -x "$PGBIN/initdb" ] || { echo "Не найден PostgreSQL (initdb). Установите: brew install postgresql@16"; exit 1; }
DIR="$(mktemp -d)"; PORT="${PGPORT_TEST:-54329}"
trap '"$PGBIN/pg_ctl" -D "$DIR" stop -m immediate >/dev/null 2>&1; rm -rf "$DIR"' EXIT
"$PGBIN/initdb" -D "$DIR" -U postgres -A trust --no-locale -E UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$DIR" -o "-p $PORT -k $DIR -c listen_addresses=''" -l "$DIR/log" start -w >/dev/null
PSQL="$PGBIN/psql -h $DIR -p $PORT -U postgres -d postgres -q -v ON_ERROR_STOP=1"
$PSQL -f supabase-stub.sql
for f in ../../supabase/migrations/*.sql; do echo "миграция: $(basename "$f")"; $PSQL -f "$f"; done
# поздние миграции должны переживать повторный запуск (первая создаёт таблицы и повторно не запускается)
if [ "$(ls ../../supabase/migrations/*.sql | wc -l)" -gt 1 ]; then
  last=$(ls ../../supabase/migrations/*.sql | tail -1); echo "повторный запуск: $(basename "$last")"; $PSQL -f "$last"
fi
$PSQL -t -A -f rights.test.sql
