#!/bin/sh
set -eu
# Initialize only the new private OAuth directory. Keep the prior /data/codex
# grant intact for rollback; the new runtime never reads or refreshes it.
if [ "$(id -u)" = 0 ]; then
  mkdir -p /data/chatgpt-plan
  chown leanbridge:leanbridge /data/chatgpt-plan
  chmod 700 /data/chatgpt-plan
  exec gosu leanbridge /usr/local/bin/docker-entrypoint.sh "$@"
fi
exec /usr/local/bin/docker-entrypoint.sh "$@"
