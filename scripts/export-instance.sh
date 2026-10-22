#!/usr/bin/env bash
# Exports a Newses instance, the Docker stack or an AWS stage, to a bundle directory that
# scripts/restore-instance.sh loads into another: its database without sessions or operations
# data, its blobs, and its APP_SECRET. See docs/self-hosting.md.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/export-instance.sh <bundle-dir> [--aws dev|prod] [--archive-only] [--freeze]

  <bundle-dir>    New or empty directory for the bundle
  --aws STAGE     Export that AWS stage (AWS CLI credentials, infra/deploy.config.json);
                  default: the Docker stack in docker/
  --archive-only  Leave out favicons and cached images, which the target fetches again
  --freeze        Stop the source first and leave it stopped, so nothing changes after the
                  export (for a cut-over)

The bundle holds password hashes and the APP_SECRET: keep it private, and delete it after the
restore.
EOF
}

die() {
  echo "export-instance: $*" >&2
  exit 2
}

# Not exported: sign-ins, the source's own operations data, and Docker's job queue (pg-boss,
# which recreates its schema when it starts).
EXCLUDED_TABLES=(sessions login_attempts rate_limits request_stats_hourly host_fetch_stats_hourly
  job_stats_hourly ops_alerts ops_state)
EXCLUDED_SCHEMAS=(pgboss)

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
bundle='' stage='' blobs=all freeze=false
while [ $# -gt 0 ]; do
  case "$1" in
    --aws) stage=${2:-}; shift 2 || die '--aws needs a stage' ;;
    --archive-only) blobs=archive; shift ;;
    --freeze) freeze=true; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) usage >&2; die "unknown option $1" ;;
    *) [ -z "$bundle" ] || die 'only one bundle directory'; bundle=$1; shift ;;
  esac
done
[ -n "$bundle" ] || { usage >&2; exit 2; }
case "$stage" in '' | dev | prod) ;; *) die "--aws takes dev or prod, not $stage" ;; esac
[ ! -e "$bundle" ] || [ -z "$(ls -A "$bundle")" ] || die "$bundle is not empty"

docker info >/dev/null 2>&1 || die 'Docker is not running'
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if [ -z "$stage" ]; then
  source_name='the Docker stack'
  label=docker
  # shellcheck source=lib/docker-stack.sh
  . "$root/scripts/lib/docker-stack.sh"
  stack_check || exit 2
  pg() { stack_pg "$@"; }
  app_secret() { stack_app_secret; }
  freeze() { "${stack_compose[@]}" stop server worker; }
  restart='docker compose -f docker/compose.yaml start server worker'
  blobs_out() { stack_blobs_out "$blobs" | tar -xf - -C "$bundle/blobs"; }
else
  source_name="AWS stage $stage"
  label="aws-$stage"
  command -v aws >/dev/null || die 'the AWS CLI is not installed'
  # shellcheck source=lib/deploy-config.sh
  . "$root/scripts/lib/deploy-config.sh"
  # shellcheck source=lib/aws-stage.sh
  . "$root/scripts/lib/aws-stage.sh"
  AWS_REGION=$(deploy_region)
  export AWS_REGION
  aws sts get-caller-identity >/dev/null || die 'no AWS credentials (set AWS_PROFILE or sign in)'
  aws_stage "$stage" "$tmp"
  [ -n "$blob_bucket" ] || die "the $stage data stack has no BlobBucket output"
  stage_prepare_image || exit 2
  pg() { stage_pg "$@"; }
  app_secret() { echo "$stage_secret"; }
  freeze() { stage_freeze; }
  restart="scripts/freeze-stage.sh $stage --undo"
  blobs_out() {
    local options=()
    [ "$blobs" = all ] || options=(--archive-only)
    stage_run -v "$bundle/blobs:/bundle" --user "$(id -u):$(id -g)" -- \
      cli blobs pull /bundle ${options[@]+"${options[@]}"}
  }
fi

umask 077
mkdir -p "$bundle/blobs"
chmod 700 "$bundle"
bundle=$(cd "$bundle" && pwd)

if $freeze; then
  echo "Stopping $source_name..."
  freeze
  echo "It stays stopped. Start it again with: $restart"
else
  echo "Warning: $source_name keeps running; changes after the database dump are not exported." >&2
fi

# The database first: purge archives entries before deleting them, so blobs copied afterwards
# hold every entry the dump lacks.
echo "Dumping the database..."
excludes=()
for table in "${EXCLUDED_TABLES[@]}"; do excludes+=("--exclude-table-data=$table"); done
for schema in "${EXCLUDED_SCHEMAS[@]}"; do excludes+=("--exclude-schema=$schema"); done
pg pg_dump -Fc --no-owner --no-acl "${excludes[@]}" >"$bundle/db.dump"
pg psql -X -q -At -c 'SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id' \
  >"$bundle/migrations"
counts=$(pg psql -X -q -At -F ' ' -c 'SELECT (SELECT count(*) FROM users),
  (SELECT count(*) FROM subscriptions), (SELECT count(*) FROM entries)')
read -r users subscriptions entries <<<"$counts"

if [ "$blobs" = all ]; then echo "Copying the blobs..."; else echo "Copying the archive..."; fi
blobs_out
blob_count=$(find "$bundle/blobs" -type f -not -path "$bundle/blobs/.meta/*" | wc -l)
app_secret >"$bundle/app-secret"

# Last: a bundle without a manifest is incomplete.
cat >"$bundle/manifest" <<EOF
format=1
source=$label
created=$(date -u +%Y-%m-%dT%H:%M:%SZ)
archive_only=$([ "$blobs" = archive ] && echo true || echo false)
users=$users
subscriptions=$subscriptions
entries=$entries
blobs=$((blob_count))
EOF

echo
echo "Exported $source_name to $bundle ($(du -sh "$bundle" | cut -f1)):"
echo "  $users users, $subscriptions subscriptions, $entries entries, $((blob_count)) blobs"
echo "Load it with scripts/restore-instance.sh. It holds password hashes and the APP_SECRET:"
echo "keep it private, and delete it after the restore."
