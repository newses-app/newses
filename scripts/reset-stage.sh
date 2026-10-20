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
domain=$(stage_domain "$stage")
admin_login=$(deploy_value adminLogin)

docker info >/dev/null 2>&1 || die 'Docker is not running'
command -v aws >/dev/null || die 'the AWS CLI is not installed'
AWS_REGION=$(deploy_region)
export AWS_REGION
aws sts get-caller-identity >/dev/null || die 'no AWS credentials (set AWS_PROFILE or sign in)'

prefix=$(deploy_prefix)
name="$prefix-$stage"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

host=$(aws ssm get-parameter --name "/$prefix/db/endpoint" --query Parameter.Value --output text)
db_name="${prefix//-/_}_$stage"
db_password=$(aws ssm get-parameter --name "/$prefix/$stage/db-password" \
  --with-decryption --query Parameter.Value --output text)
blob_bucket=$(aws cloudformation describe-stacks --stack-name "$name-data" \
  --query "Stacks[0].Outputs[?OutputKey=='BlobBucket'].OutputValue" --output text)
case "$blob_bucket" in '' | None) die "the $stage data stack has no BlobBucket output; deploy it first" ;; esac
curl -fsSo "$tmp/rds-ca.pem" https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem

psql() {
  # The password reaches the container through its environment, never its command line.
  PGPASSWORD=$db_password docker run --rm -i -e PGPASSWORD \
    -v "$tmp/rds-ca.pem:/rds-ca.pem:ro" postgres:18-alpine \
    psql "postgres://$db_name@$host:5432/$db_name?sslmode=verify-full&sslrootcert=/rds-ca.pem" \
    -v ON_ERROR_STOP=1 -X -q "$@"
}

echo "Connecting to $db_name on $host..."
counts=$(psql -At -c "SELECT (SELECT count(*) FROM users) || ' users, ' ||
  (SELECT count(*) FROM subscriptions) || ' subscriptions, ' ||
  (SELECT count(*) FROM entries) || ' entries'") || counts='unreadable (above)'
objects=$(aws s3 ls "s3://$blob_bucket" --recursive --summarize |
  sed -n 's/^ *Total Objects: //p')
aws lambda get-function --function-name "$name-migrate" >/dev/null ||
  die "no $name-migrate function; deploy the app stack first"
# Resolved before anything is deleted, so a missing queue stops the reset early.
queues=() messages=0
for queue in feed-fetch feed-favicon entry-extract; do
  for suffix in '' -dlq; do
    url=$(aws sqs get-queue-url --queue-name "$name-$queue$suffix" --query QueueUrl --output text)
    queues+=("$url")
    count=$(aws sqs get-queue-attributes --queue-url "$url" \
      --attribute-names ApproximateNumberOfMessages \
      --query Attributes.ApproximateNumberOfMessages --output text)
    messages=$((messages + count))
  done
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

if [ "$stage" = prod ]; then
  snapshot="$name-pre-reset-$(date +%Y%m%d-%H%M%S)"
  echo "Snapshotting the database instance as $snapshot..."
  aws rds create-db-snapshot --db-instance-identifier "$prefix-db" \
    --db-snapshot-identifier "$snapshot" >/dev/null
  aws rds wait db-snapshot-available --db-snapshot-identifier "$snapshot"
fi

echo "Dropping the database schema..."
psql -1 <<'SQL'
DROP SCHEMA IF EXISTS drizzle CASCADE;
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
SQL

echo "Applying migrations and creating the admin..."
error=$(aws lambda invoke --function-name "$name-migrate" --cli-read-timeout 900 \
  --query FunctionError --output text "$tmp/migrate.json")
[ "$error" = None ] || die "the migrate function failed: $(cat "$tmp/migrate.json")"

echo "Emptying the blob bucket..."
aws s3 rm "s3://$blob_bucket" --recursive --only-show-errors

# Last, so jobs enqueued by a dispatch tick during the reset go too.
echo "Purging the job queues..."
for url in "${queues[@]}"; do
  aws sqs purge-queue --queue-url "$url"
done

echo
echo "Stage $stage is empty. Within 7 days, sign in at https://$domain as $admin_login with the password from:"
echo "  aws ssm get-parameter --name /$prefix/$stage/admin-password --with-decryption --query Parameter.Value --output text"
echo "Every session and app password is gone: the apps must sign in again."
[ "$stage" != prod ] || echo "The previous data is in database snapshot $snapshot."
