#!/usr/bin/env bash
#
# One command to get Hasino running locally.
#
#   ./scripts/dev.sh
#
# Creates the database if it does not exist, applies the schema, loads the
# service catalogue, and starts the server with real Google sign-in.
#
# There is no demo data and no identity dropdown: local development
# authenticates exactly the way production does, so a sign-in bug is found here
# rather than on the first deploy. That needs Clerk keys in .env — this
# script stops with the console steps if it is missing.
#
# Everything here is deliberately explicit rather than clever: the failure modes
# of a local setup script are all "it did something you did not expect to a
# database you cared about".

set -euo pipefail

cd "$(dirname "$0")/.."

# .env is gitignored and holds the Clerk keys. Loaded here rather than via
# node --env-file so the checks below can see the values too.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

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

# ---------- catalogue ----------
# Services only — no users, no salons. Onboard those from /admin. This is
# additive and truncates nothing, so it is safe on every run.
if [ "$RESEED" = "true" ]; then
  dim "loading the service catalogue"
  node scripts/seed-catalog.ts >/dev/null
fi

# ---------- clerk ----------
# Checked after the database work so a first run still leaves a usable database
# behind, and before the server starts so sign-in cannot fail silently.
if [ -z "${CLERK_PUBLISHABLE_KEY:-}" ] || [ -z "${CLERK_SECRET_KEY:-}" ]; then
  echo
  red "No Clerk keys — sign-in would fail silently, so this stops here."
  echo
  echo "  Local development uses the same Google sign-in as production."
  echo
  echo "  1. https://dashboard.clerk.com — create or open an application"
  echo "  2. User & Authentication > Social Connections — enable Google"
  echo "  3. User & Authentication > Email, Phone, Username — leave Phone OFF"
  echo "       (Google supplies the whole identity; requiring a phone parks"
  echo "        every new sign-up waiting for input this app never asks for)"
  echo "  4. Domains — add http://localhost:$PORT"
  echo "  5. API keys — copy both keys"
  echo
  echo "  Then put them in .env (cp .env.example .env):"
  echo
  dim "     CLERK_PUBLISHABLE_KEY=pk_test_..."
  dim "     CLERK_SECRET_KEY=sk_test_..."
  dim "     ADMIN_EMAILS=you@example.com"
  echo
  echo "  ADMIN_EMAILS decides who gets /admin. Sign in with that Google account."
  echo
  exit 1
fi

if [ -z "${ADMIN_EMAILS:-}" ]; then
  echo
  red "ADMIN_EMAILS is not set — nobody can reach /admin, so no salon can be onboarded."
  echo "  Add your Google address to .env:"
  dim  "     ADMIN_EMAILS=you@example.com"
  echo
  exit 1
fi

echo
grn "ready"
echo
echo "  customer app   http://localhost:$PORT"
echo "  salon panel    http://localhost:$PORT/business"
echo
echo "  admin panel    http://localhost:$PORT/admin"
echo
dim "Sign in with Google via Clerk. ADMIN_EMAILS=${ADMIN_EMAILS} gets /admin."
dim "The database has a service catalogue and nothing else — onboard a salon from /admin."
dim "Emails are printed to this terminal instead of being sent."
echo

PORT="$PORT" LOG_FORMAT=pretty exec node --watch src/main.ts
