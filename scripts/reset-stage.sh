#!/usr/bin/env bash
# Resets an AWS stage to a fresh, empty instance: drops the database schema, re-runs the migrate
# function (which recreates the admin), empties the blob bucket, and purges the job queues.
# Keeps the SSM parameters and the downloads bucket. Snapshots the shared database instance first
# when resetting prod.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/reset-stage.sh <dev|prod> [--dry-run] [--yes]

  Deletes every user, subscription, entry, cached image, favicon, and archived entry in the
  stage, then recreates the admin (adminLogin) with the password in SSM, which must be changed
  at first sign-in and expires after 7 days.
  prod is snapshotted first (<prefix>-prod-pre-reset-<time>).

  --dry-run  Look everything up and show what would be deleted, then stop
  --yes      dev only: reset without asking
EOF
}

die() {
  echo "reset-stage: $*" >&2
  exit 2
}

stage='' dry_run=false yes=false
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=true; shift ;;
    --yes) yes=true; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) usage >&2; die "unknown option $1" ;;
    *) [ -z "$stage" ] || die 'only one stage'; stage=$1; shift ;;
  esac
done
case "$stage" in
  dev | prod) ;;
  '') usage >&2; exit 2 ;;
  *) die "the stage is dev or prod, not $stage" ;;
esac
[ "$stage" = dev ] || ! $yes || die '--yes is for dev only'
# shellcheck source=lib/deploy-config.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/deploy-config.sh"
# shellcheck source=lib/aws-stage.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/aws-stage.sh"
domain=$(stage_domain "$stage")
admin_login=$(deploy_value adminLogin)

docker info >/dev/null 2>&1 || die 'Docker is not running'
command -v aws >/dev/null || die 'the AWS CLI is not installed'
AWS_REGION=$(deploy_region)
export AWS_REGION
aws sts get-caller-identity >/dev/null || die 'no AWS credentials (set AWS_PROFILE or sign in)'

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
aws_stage "$stage" "$tmp"
name=$stage_name
[ -n "$blob_bucket" ] || die "the $stage data stack has no BlobBucket output; deploy it first"

psql() { stage_pg psql -v ON_ERROR_STOP=1 -X -q "$@"; }

echo "Connecting to $db_name on $db_host..."
counts=$(psql -At -c "SELECT (SELECT count(*) FROM users) || ' users, ' ||
  (SELECT count(*) FROM subscriptions) || ' subscriptions, ' ||
  (SELECT count(*) FROM entries) || ' entries'") || counts='unreadable (above)'
objects=$(aws s3 ls "s3://$blob_bucket" --recursive --summarize |
  sed -n 's/^ *Total Objects: //p')
aws lambda get-function --function-name "$name-migrate" >/dev/null ||
  die "no $name-migrate function; deploy the app stack first"
# Resolved before anything is deleted, so a missing queue stops the reset early.
queues=() messages=0
urls=$(stage_queues) || die "a job queue is missing; deploy the $stage app stack first"
for url in $urls; do
  queues+=("$url")
  count=$(aws sqs get-queue-attributes --queue-url "$url" \
    --attribute-names ApproximateNumberOfMessages \
    --query Attributes.ApproximateNumberOfMessages --output text)
  messages=$((messages + count))
done

echo
echo "Reset AWS stage $stage ($domain):"
echo "  database: $counts"
echo "  blob bucket $blob_bucket: ${objects:-0} objects"
echo "  ${#queues[@]} job queues: about $messages messages"
echo "Kept: SSM parameters, the downloads bucket."
[ "$stage" != prod ] || echo "The database instance, holding every stage, is snapshotted first."
if $dry_run; then
  echo 'Dry run: nothing reset.'
  exit 0
fi
if ! $yes; then
  [ -t 0 ] || die 'not a terminal: run it interactively'
  read -r -p "Type $domain to delete all of this: " answer
  [ "$answer" = "$domain" ] || { echo 'Nothing reset.'; exit 0; }
fi

[ "$stage" != prod ] || snapshot=$(stage_snapshot pre-reset)

echo "Dropping the database schema..."
psql -1 <<'SQL'
DROP SCHEMA IF EXISTS drizzle CASCADE;
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
SQL

echo "Applying migrations and creating the admin..."
stage_migrate || exit 2

echo "Emptying the blob bucket..."
aws s3 rm "s3://$blob_bucket" --recursive --only-show-errors

# Last, so jobs enqueued by a dispatch tick during the reset go too.
echo "Purging the job queues..."
for url in "${queues[@]}"; do
  aws sqs purge-queue --queue-url "$url"
done

echo
echo "Stage $stage is empty. Within 7 days, sign in at https://$domain as $admin_login with the password from:"
echo "  aws ssm get-parameter --name /$stage_prefix/$stage/admin-password --with-decryption --query Parameter.Value --output text"
echo "Every session and app password is gone: the apps must sign in again."
[ "$stage" != prod ] || echo "The previous data is in database snapshot $snapshot."
