#!/bin/sh
set -eu

: "${BENCH_POSTGRES_DATABASES:?BENCH_POSTGRES_DATABASES is required}"

ready_marker="$PGDATA/.frontal-benchmark-ready"
rm -f "$ready_marker"

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  install -d -m 0700 -o postgres -g postgres "$PGDATA"
  gosu postgres initdb -D "$PGDATA" --auth-local=trust --auth-host=trust --encoding=UTF8 --no-locale >"/tmp/frontal-benchmark-initdb.log"
fi

if ! gosu postgres pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
  gosu postgres pg_ctl -D "$PGDATA" -l "/tmp/frontal-benchmark-postgres.log" -o "-h 127.0.0.1 -p 5432" start >/dev/null
fi

for database in $BENCH_POSTGRES_DATABASES; do
  case "$database" in
    *[!A-Za-z0-9_]*)
      echo "Invalid PostgreSQL database name" >&2
      exit 64
      ;;
  esac
  if ! gosu postgres psql -h 127.0.0.1 -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$database'" | grep -q 1; then
    gosu postgres createdb -h 127.0.0.1 -U postgres "$database"
  fi
done

: >"$ready_marker"
exec "$@"
