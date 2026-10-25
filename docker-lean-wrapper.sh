#!/bin/sh
set -eu

if [ "$#" -eq 3 ] && [ "$1" = "env" ] && [ "$2" = "lean" ]; then
  LEAN_PATH="$(cat /app/lean-project/.lean-path)"
  lean_bin="$(cat /app/lean-project/.lean-bin)"
else
  echo "leanbridge-lake-env only supports: env lean <source>" >&2
  exit 64
fi

case "$lean_bin" in
  /opt/elan/toolchains/*/bin/lean) ;;
  *)
    echo "invalid pinned Lean executable" >&2
    exit 65
    ;;
esac

export LEAN_PATH
if [ -f /usr/local/lib/liblean_memguard.so ]; then
  export LD_PRELOAD="/usr/local/lib/liblean_memguard.so${LD_PRELOAD:+:$LD_PRELOAD}"
fi
# Keep one compiler worker and cap Lean's internal heap at 192 MB so the web
# server, kernel slab, and mapped .olean file cache fit safely inside 512 MB.
exec "$lean_bin" -j1 -M192 "$3"
