# shellcheck shell=bash
# Sourced by scripts that act on a Docker install's database and blobs: stack_use picks the
# install, from a checkout or from a release's compose file, and the other functions act on it.

stack_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

# Picks the install by its compose files, one or several as `docker compose -f` takes them; with
# none, the files COMPOSE_FILE names, else this checkout's docker/compose.yaml. The install's
# .env and project name come with it; COMPOSE_PROJECT_NAME and COMPOSE_ENV_FILES pick others.
# Sets stack_compose, to run, and stack_command, to show.
stack_use() {
  local file
  stack_compose=(docker compose)
  stack_command='docker compose'
  if [ $# -gt 0 ]; then
    for file in "$@"; do
      [ -r "$file" ] || { echo "cannot read $file" >&2; return 2; }
      stack_compose+=(-f "$file")
      stack_command+=" -f $file"
    done
  elif [ -z "${COMPOSE_FILE:-}" ]; then
    stack_compose+=(-f "$stack_root/docker/compose.yaml")
    stack_command+=' -f docker/compose.yaml'
  fi
}

# Fails unless the install has been started (`up -d`) and its database is running; warns when
# its image is a release other than this checkout's, whose scripts may not match it.
stack_check() {
  local server image checkout
  server=$("${stack_compose[@]}" ps -a -q server)
  [ -n "$server" ] && [ -n "$("${stack_compose[@]}" ps -q db)" ] || {
    echo "the Docker install is not running; start it with: $stack_command up -d" >&2
    return 2
  }
  image=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$server" |
    sed -n 's/^NEWSES_VERSION=//p')
  # Images built from a checkout have no release version.
  case "$image" in '' | dev | 0.0.0-dev) return 0 ;; esac
  checkout=$(git -C "$stack_root" describe --tags --always 2>/dev/null || echo unknown)
  [ "$checkout" = "v$image" ] ||
    echo "Warning: the install runs Newses $image, but these scripts are from $checkout; for its own, run them from a checkout of v$image (git checkout v$image)" >&2
}

# How to upgrade the install: rebuild from the checkout, or the next release's compose file.
stack_upgrade() {
  if "${stack_compose[@]}" config --format json | grep -q '"build": *{'; then
    echo "git pull && $stack_command up -d --build"
  else
    echo "download a newer release's compose file over yours, then $stack_command up -d"
  fi
}

# Runs PostgreSQL client $1 (psql, pg_dump, pg_restore) on the install's database, passing stdin.
stack_pg() {
  # shellcheck disable=SC2016 # expanded in the container
  "${stack_compose[@]}" exec -T db sh -c \
    'tool=$1; shift; exec "$tool" -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' sh "$@"
}

# Runs `newses cli` on the install's image and configuration, passing stdin.
stack_cli() {
  "${stack_compose[@]}" run --rm --no-deps -T server cli "$@"
}

# The install's APP_SECRET.
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
