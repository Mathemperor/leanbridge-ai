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
# Keep one compiler worker and cap Lean's internal heap at 192 MB so Lean has
# sufficient headroom for Mathlib elaboration without GC thrashing or timeouts.
exec "$lean_bin" -j1 -M192 "$3"
