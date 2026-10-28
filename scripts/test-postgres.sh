#!/bin/sh
# Integration tests against a real PostgreSQL server, the way production runs it: the app connects
# as a NON-superuser that owns the database (CREATEROLE, so migrations can create the lms_app role).
# Each test file gets its own fresh database.
#
#   ADMIN_URL=postgresql://postgres:postgres@localhost:5432/postgres sh scripts/test-postgres.sh
#
# ADMIN_URL must be a superuser (or a role allowed to create roles and databases).
set -eu
ADMIN_URL="${ADMIN_URL:?set ADMIN_URL to a superuser connection URL}"
APP_USER="${APP_USER:-lms_owner}"
APP_PASSWORD="${APP_PASSWORD:-lms_owner_password}"
base="${ADMIN_URL%/*}"
host_part="${base#*@}"

psql "$ADMIN_URL" -qc "do \$\$ begin if not exists (select 1 from pg_roles where rolname = '$APP_USER') then create role $APP_USER login createrole password '$APP_PASSWORD'; end if; end \$\$"

cd apps/api
failed=0
i=0
for file in $(find src test -name '*.integration.test.ts' | sort); do
  i=$((i + 1))
  db="lms_it_$i"
  psql "$ADMIN_URL" -qc "drop database if exists $db" -c "create database $db owner $APP_USER"
  psql "$base/$db" -qc "alter schema public owner to $APP_USER"
  if DATABASE_URL="postgresql://$APP_USER:$APP_PASSWORD@$host_part/$db" PGLITE_DIR= npx vitest run "$file"; then
    :
  else
    failed=$((failed + 1))
  fi
  psql "$ADMIN_URL" -qc "drop database if exists $db"
done
echo "integration test files failed on PostgreSQL: $failed"
[ "$failed" -eq 0 ]
