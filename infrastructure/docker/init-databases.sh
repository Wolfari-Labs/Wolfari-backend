#!/usr/bin/env bash
set -euo pipefail

# Runs once on an empty PostgreSQL volume, using the official image entrypoint.
# Each application role owns exactly one database; no business tables are created.
for service in identity trip travel finance automation; do
  upper_service="${service^^}"
  user_variable="${upper_service}_DB_USER"
  password_variable="${upper_service}_DB_PASSWORD"
  app_user="${!user_variable:?Missing database user}"
  app_password="${!password_variable:?Missing database password}"
  database="${service}_db"

  psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    --set=app_user="$app_user" --set=app_password="$app_password" \
    --set=app_database="$database" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'app_user', :'app_password') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'app_database', :'app_user') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'app_database') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'app_database', :'app_user') \gexec
SQL
done
