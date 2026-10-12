#!/bin/sh
# Selects the process role: server (default), worker, migrate, or cli. Anything else runs as a command.
# The telemetry preload starts OpenTelemetry only when OTEL_EXPORTER_OTLP_ENDPOINT is set.
set -e
role="${1:-server}"
[ "$#" -gt 0 ] && shift
case "$role" in
  server | worker | migrate | cli) exec node --import /app/server/src/telemetry/register.ts "/app/server/src/entrypoints/$role.ts" "$@" ;;
  *) exec "$role" "$@" ;;
esac
