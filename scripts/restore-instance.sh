#!/usr/bin/env bash
# Replaces the data of the Docker stack or an AWS stage with a bundle from
# scripts/export-instance.sh: restores the database, applies the target's newer migrations,
# re-seals two-factor secrets with the target's APP_SECRET, and replaces the blobs.
# See docs/self-hosting.md.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/restore-instance.sh <bundle-dir> [--aws dev|prod] [--dry-run] [--yes]

  Replaces every user, subscription, entry, and blob of the target with the bundle's. Everyone
  signs in again. The target keeps its APP_SECRET and settings, and must run the bundle's
  version of Newses or a newer one.
  The Docker stack's database is saved first as newses-pre-restore-<time>.dump in the current
  directory; prod is snapshotted first (<prefix>-prod-pre-restore-<time>).

  --aws STAGE  Restore into that AWS stage (AWS CLI credentials, infra/deploy.config.json);
               default: the Docker stack in docker/
  --dry-run    Check the bundle and the target and show what would be replaced, then stop
  --yes        Restore without asking (not into prod)
EOF
}

die() {
  echo "restore-instance: $*" >&2
  exit 2
}

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
bundle='' stage='' dry_run=false yes=false
while [ $# -gt 0 ]; do
  case "$1" in
    --aws) stage=${2:-}; shift 2 || die '--aws needs a stage' ;;
    --dry-run) dry_run=true; shift ;;
    --yes) yes=true; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) usage >&2; die "unknown option $1" ;;
    *) [ -z "$bundle" ] || die 'only one bundle directory'; bundle=$1; shift ;;
  esac
done
[ -n "$bundle" ] || { usage >&2; exit 2; }
case "$stage" in '' | dev | prod) ;; *) die "--aws takes dev or prod, not $stage" ;; esac
[ "$stage" != prod ] || ! $yes || die '--yes is not for prod'

[ -f "$bundle/manifest" ] || die "$bundle has no manifest: not a bundle, or its export did not finish"
bundle=$(cd "$bundle" && pwd)
for file in db.dump migrations app-secret blobs; do
  [ -e "$bundle/$file" ] || die "the bundle has no $file"
done
manifest() { sed -n "s/^$1=//p" "$bundle/manifest"; }
[ "$(manifest format)" = 1 ] || die "the bundle's format, $(manifest format), is not one this checkout reads"

docker info >/dev/null 2>&1 || die 'Docker is not running'
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if [ -z "$stage" ]; then
  target='the Docker stack'
  # shellcheck source=lib/docker-stack.sh
  . "$root/scripts/lib/docker-stack.sh"
  stack_check || exit 2
  stack_cli 2>&1 | grep -q reseal-secrets ||
    die "the Docker stack's image cannot re-seal secrets: upgrade it first (git pull && docker compose -f docker/compose.yaml up -d --build)"
  pg() { stack_pg "$@"; }
  cli() { stack_cli "$@"; }
  freeze() { "${stack_compose[@]}" stop server worker; }
  unfreeze() { "${stack_compose[@]}" start server worker; }
  restart='docker compose -f docker/compose.yaml up -d'
  migrate() { "${stack_compose[@]}" run --rm --no-deps migrate; }
  blobs_in() { tar -C "$bundle/blobs" -cf - . | stack_blobs_in; }
else
  target="AWS stage $stage"
  command -v aws >/dev/null || die 'the AWS CLI is not installed'
  # shellcheck source=lib/deploy-config.sh
  . "$root/scripts/lib/deploy-config.sh"
  # shellcheck source=lib/aws-stage.sh
  . "$root/scripts/lib/aws-stage.sh"
  domain=$(stage_domain "$stage")
  AWS_REGION=$(deploy_region)
  export AWS_REGION
  aws sts get-caller-identity >/dev/null || die 'no AWS credentials (set AWS_PROFILE or sign in)'
  aws_stage "$stage" "$tmp"
  [ -n "$blob_bucket" ] || die "the $stage data stack has no BlobBucket output; deploy it first"
  aws lambda get-function --function-name "$stage_name-migrate" >/dev/null ||
    die "no $stage_name-migrate function; deploy the app stack first"
  # Resolved before anything is replaced, so a missing queue stops the restore early.
  queues=$(stage_queues) || die "a job queue is missing; deploy the $stage app stack first"
  pg() { stage_pg "$@"; }
  cli() { stage_run -i -- cli "$@"; }
  freeze() { stage_freeze; }
  unfreeze() { stage_unfreeze; }
  restart="scripts/freeze-stage.sh $stage --undo"
  migrate() { stage_migrate; }
  blobs_in() {
    aws s3 rm "s3://$blob_bucket" --recursive --only-show-errors
    stage_run -v "$bundle/blobs:/bundle:ro" --user "$(id -u):$(id -g)" -- cli blobs push /bundle
  }
fi

# The target must already have every migration the bundle's database has; it applies its newer
# ones after the restore.
applied=$(pg psql -X -q -At -c 'SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id') ||
  die "cannot read the migrations of $target"
missing=$(grep -cvxF -f <(printf '%s\n' "$applied") "$bundle/migrations" || true)
[ "$missing" -eq 0 ] ||
  die "the bundle is from a newer version of Newses than $target ($missing migrations ahead): upgrade the target first"
counts=$(pg psql -X -q -At -c "SELECT (SELECT count(*) FROM users) || ' users, ' ||
  (SELECT count(*) FROM subscriptions) || ' subscriptions, ' ||
  (SELECT count(*) FROM entries) || ' entries'")

echo
echo "Restore into $target${domain:+ ($domain)}:"
echo "  replacing: $counts"
echo "  with the $(manifest source) export of $(manifest created): $(manifest users) users," \
  "$(manifest subscriptions) subscriptions, $(manifest entries) entries, $(manifest blobs) blobs"
[ "$(manifest archive_only)" != true ] || echo '  (archive only: favicons and images are fetched again)'
echo 'Kept: the target'"'"'s APP_SECRET and settings. Everyone signs in again.'
if $dry_run; then
  echo 'Dry run: nothing restored.'
  exit 0
fi
if ! $yes; then
  [ -t 0 ] || die 'not a terminal: pass --yes to restore without asking'
  if [ -n "$stage" ]; then
    read -r -p "Type $domain to replace its data: " answer
    [ "$answer" = "$domain" ] || { echo 'Nothing restored.'; exit 0; }
  else
    read -r -p "Replace all data in $target? [y/N] " answer
    [[ "$answer" =~ ^[Yy] ]] || { echo 'Nothing restored.'; exit 0; }
  fi
fi

# Re-sealing and blob copies on AWS run the image built from this checkout.
if [ -n "$stage" ]; then stage_prepare_image || exit 2; fi

# From here on the target is stopped; a failure leaves it stopped, for a retry.
done=false
# shellcheck disable=SC2329 # run by the EXIT trap
finish() {
  rm -rf "$tmp"
  $done || echo "The restore did not finish: $target is stopped. Re-run the restore, or start it again with: $restart" >&2
}
trap finish EXIT
trap 'exit 130' INT TERM

echo "Stopping $target..."
freeze
if [ -z "$stage" ]; then
  saved="newses-pre-restore-$(date +%Y%m%d-%H%M%S).dump"
  echo "Saving its database as $saved..."
  (umask 077 && pg pg_dump -Fc >"$saved")
elif [ "$stage" = prod ]; then
  snapshot=$(stage_snapshot pre-restore)
fi

echo "Restoring the database..."
# One transaction, committed only when the whole dump was read: a failure leaves the database as
# it was. The job queue's schema (pg-boss, on Docker) goes too; it is recreated at start.
{
  cat <<'SQL'
SET client_min_messages = warning;
BEGIN;
DROP SCHEMA IF EXISTS drizzle CASCADE;
DROP SCHEMA IF EXISTS pgboss CASCADE;
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
SQL
  docker run --rm -i postgres:18-alpine pg_restore --no-owner --no-acl -f - <"$bundle/db.dump" &&
    echo 'COMMIT;'
} | pg psql -X -q -v ON_ERROR_STOP=1 >/dev/null

echo "Applying newer migrations..."
migrate

echo "Re-sealing two-factor secrets with the target's APP_SECRET..."
cli reseal-secrets <"$bundle/app-secret"

echo "Replacing the blobs..."
blobs_in

if [ -n "$stage" ]; then
  # Jobs queued for the replaced data.
  echo "Purging the job queues..."
  for url in $queues; do aws sqs purge-queue --queue-url "$url"; done
fi

echo "Starting $target..."
unfreeze
done=true

echo
echo "Restored the $(manifest source) export into $target."
echo "Everyone signs in again; the apps need the new server address if it changed. Links to"
echo "shared articles and feeds use the old address until it points here."
[ -z "${saved:-}" ] || echo "The previous database is in $saved."
[ -z "${snapshot:-}" ] || echo "The previous data is in database snapshot $snapshot."
echo "Delete the bundle, which holds password hashes and the source's APP_SECRET: rm -rf $bundle"
