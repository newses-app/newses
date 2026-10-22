# shellcheck shell=bash
# Sourced by scripts that act on the Docker stack's database and blobs. The stack is the one
# docker/compose.yaml names; COMPOSE_PROJECT_NAME and COMPOSE_ENV_FILES pick another.

stack_compose=(docker compose -f "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/docker/compose.yaml")

# Fails unless the stack has been started (`up -d`) and its database is running.
stack_check() {
  [ -n "$("${stack_compose[@]}" ps -a -q server)" ] && [ -n "$("${stack_compose[@]}" ps -q db)" ] || {
    echo 'the Docker stack is not running; start it with: docker compose -f docker/compose.yaml up -d' >&2
    return 2
  }
}

# Runs PostgreSQL client $1 (psql, pg_dump, pg_restore) on the stack's database, passing stdin.
stack_pg() {
  # shellcheck disable=SC2016 # expanded in the container
  "${stack_compose[@]}" exec -T db sh -c \
    'tool=$1; shift; exec "$tool" -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' sh "$@"
}

# Runs `newses cli` with the stack's configuration, passing stdin.
stack_cli() {
  "${stack_compose[@]}" run --rm --no-deps -T server cli "$@"
}

# The stack's APP_SECRET.
stack_app_secret() {
  "${stack_compose[@]}" run --rm --no-deps -T --entrypoint printenv server APP_SECRET
}

# Writes the blobs volume as a tar stream (only the archive with `archive`), skipping writes in
# progress. The layout is LocalBlobStore's: data files, and content types under .meta/.
stack_blobs_out() {
  # shellcheck disable=SC2016 # expanded in the container
  "${stack_compose[@]}" run --rm --no-deps -T --entrypoint sh server -c '
    cd /data/blobs
    [ "$1" = archive ] && set -- $(ls -d archive .meta/archive 2>/dev/null) || set -- .
    # An empty archive is an error for busybox tar; an empty directory is not.
    [ $# -gt 0 ] || { mkdir -p /tmp/none && cd /tmp/none && set -- .; }
    exec tar -cf - --exclude="*.tmp" "$@"
  ' sh "${1:-all}"
}

# Replaces the blobs volume's contents with the tar stream on stdin.
stack_blobs_in() {
  "${stack_compose[@]}" run --rm --no-deps -T --entrypoint sh server -c '
    find /data/blobs -mindepth 1 -delete && exec tar -xf - -C /data/blobs
  '
}
