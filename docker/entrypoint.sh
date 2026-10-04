#!/bin/sh
# Selects the process role: server (default), worker, or migrate. Anything else runs as a command.
set -e
role="${1:-server}"
[ "$#" -gt 0 ] && shift
case "$role" in
  server | worker | migrate) exec node "/app/server/src/entrypoints/$role.ts" "$@" ;;
  *) exec "$role" "$@" ;;
esac
