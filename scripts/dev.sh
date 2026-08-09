#!/usr/bin/env bash
#
# One command to get Hasino running locally.
#
#   ./scripts/dev.sh
#
# Creates the database if it does not exist, applies the schema, seeds demo
# data, and starts the server with DEV_AUTH on. Safe to re-run — re-running
# reseeds, which wipes local data and nothing else.
#
# Everything here is deliberately explicit rather than clever: the failure modes
# of a local setup script are all "it did something you did not expect to a
# database you cared about".

set -euo pipefail

cd "$(dirname "$0")/.."

DB_NAME="${DB_NAME:-hasino_dev}"
PORT="${PORT:-3000}"
RESEED="${RESEED:-true}"

red()  { printf '\033[31m%s\033[0m\n' "$1"; }
grn()  { printf '\033[32m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }

# ---------- node ----------
if ! command -v node >/dev/null 2>&1; then
  red "node is not installed."
  echo "  brew install node        (or https://nodejs.org)"
  exit 1
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]')
# This repo has no build step: Node runs the TypeScript directly via type
# stripping, which landed in 22.18. On anything older every import fails with a
# syntax error that does not obviously say "your Node is too old".
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 18 ]; }; then
  red "Node $(node -v) is too old — this repo runs TypeScript directly and needs >= 22.18."
  echo "  brew upgrade node"
  exit 1
fi

# ---------- postgres ----------
if ! command -v psql >/dev/null 2>&1; then
  red "psql is not installed."
  echo "  brew install postgresql@16 && brew services start postgresql@16"
  echo "  (or install Postgres.app from https://postgresapp.com)"
  exit 1
fi

if ! pg_isready -q 2>/dev/null; then
  red "Postgres is installed but not running."
  echo "  brew services start postgresql@16"
  echo "  (or open Postgres.app and press Start)"
  exit 1
fi

export DATABASE_URL="${DATABASE_URL:-postgres://localhost:5432/$DB_NAME}"

# RESET=true starts from nothing. Worth having because the usual way a local
# database gets wedged is a half-applied schema, and the fix for that is not
# worth debugging on a machine with no production data on it.
if [ "${RESET:-false}" = "true" ]; then
  dim "dropping database $DB_NAME"
  dropdb --if-exists "$DB_NAME"
fi

if ! psql -lqt 2>/dev/null | cut -d\| -f1 | grep -qw "$DB_NAME"; then
  dim "creating database $DB_NAME"
  createdb "$DB_NAME"
fi

# ---------- deps ----------
if [ ! -d node_modules ]; then
  dim "installing dependencies"
  npm install --silent
fi

# ---------- schema ----------
#
# These two are NOT interchangeable, and running the wrong one is how this
# script broke the first time.
#
# schema.sql is the fresh-install path. Its statements are CREATE TABLE IF NOT
# EXISTS, which means that on a database whose tables already exist it silently
# does *nothing* — including skipping any column added since. The next statement
# that indexes one of those columns then fails with "column does not exist",
# which reads like a bug in the schema and is really "this file was pointed at
# the wrong kind of database".
#
# So: schema.sql only on an empty database, migrations always.
FRESH=$(psql -tAq -d "$DATABASE_URL" -c "SELECT to_regclass('public.bookings') IS NULL")

if [ "$FRESH" = "t" ]; then
  dim "empty database — applying db/schema.sql"
  psql -v ON_ERROR_STOP=1 -q -d "$DATABASE_URL" -f db/schema.sql
else
  dim "existing database — skipping schema.sql, applying migrations only"
fi

node scripts/migrate.ts

# ---------- seed ----------
if [ "$RESEED" = "true" ]; then
  dim "seeding demo data (truncates $DB_NAME)"
  node scripts/seed-demo.ts >/dev/null
fi

echo
grn "ready"
echo
echo "  customer app   http://localhost:$PORT"
echo "  salon panel    http://localhost:$PORT/business"
echo
dim "DEV_AUTH is on — pick an identity from the dropdown, top right."
dim "Razorpay runs against the in-process stub, so 'Pay' completes without real keys."
dim "Emails are printed to this terminal instead of being sent."
echo

DEV_AUTH=true PORT="$PORT" LOG_FORMAT=pretty exec node --watch src/main.ts
