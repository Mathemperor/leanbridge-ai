#!/bin/sh
set -eu

umask 077
for stale_secret in /tmp/leanbridge-secrets.*; do
  [ -e "$stale_secret" ] || continue
  rm -f -- "$stale_secret"
done
secret_file="$(mktemp /tmp/leanbridge-secrets.XXXXXX)"
cleanup() {
  rm -f "$secret_file"
}
trap cleanup EXIT HUP INT TERM

printf '%s\0%s\0%s\0' \
  "${OPENAI_API_KEY:-}" \
  "${NEBIUS_API_KEY:-}" \
  "${LEANBRIDGE_BACKEND_TOKEN:-}" > "$secret_file"
unset OPENAI_API_KEY NEBIUS_API_KEY LEANBRIDGE_BACKEND_TOKEN
export LEANBRIDGE_SECRET_FILE="$secret_file"

exec "$@"
