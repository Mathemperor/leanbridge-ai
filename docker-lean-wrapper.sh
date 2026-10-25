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
# Keep one compiler worker and cap Lean's internal heap at 112 MB so total memory
# (Node 45 MB + Lean 100 MB + .olean cache 240 MB) peaks safely below 400 MB.
exec "$lean_bin" -j1 -M112 "$3"
