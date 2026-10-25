#!/bin/sh
set -eu
# Only initialize the dedicated persistent login directory as root. The web
# server, Codex, and Lean run as the existing unprivileged application account.
if [ "$(id -u)" = 0 ]; then
  mkdir -p /data/codex
  chown leanbridge:leanbridge /data/codex
  chmod 700 /data/codex
  exec gosu leanbridge /usr/local/bin/docker-entrypoint.sh "$@"
fi
exec /usr/local/bin/docker-entrypoint.sh "$@"
