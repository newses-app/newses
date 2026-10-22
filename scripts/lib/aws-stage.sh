# shellcheck shell=bash
# Sourced, after deploy-config.sh, by scripts that act on an AWS stage's database, blobs, and
# functions. They need Docker, the AWS CLI with credentials, and AWS_REGION exported.

stage_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

# Looks up stage $1 and sets stage, stage_prefix, stage_name (<prefix>-<stage>), db_host, db_name,
# db_password, and blob_bucket (empty when the data stack has none); saves the RDS certificate
# bundle in directory $2, for stage_pg and stage_run.
aws_stage() {
  stage=$1
  stage_dir=$2
  stage_prefix=$(deploy_prefix) || return
  stage_name="$stage_prefix-$stage"
  db_host=$(aws ssm get-parameter --name "/$stage_prefix/db/endpoint" \
    --query Parameter.Value --output text) || return
  db_name="${stage_prefix//-/_}_$stage"
  db_password=$(aws ssm get-parameter --name "/$stage_prefix/$stage/db-password" \
    --with-decryption --query Parameter.Value --output text) || return
  blob_bucket=$(aws cloudformation describe-stacks --stack-name "$stage_name-data" \
    --query "Stacks[0].Outputs[?OutputKey=='BlobBucket'].OutputValue" --output text) || return
  case "$blob_bucket" in None) blob_bucket='' ;; esac
  curl -fsSo "$stage_dir/rds-ca.pem" \
    https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
}

# The stage's APP_SECRET.
stage_app_secret() {
  aws ssm get-parameter --name "/$stage_prefix/$stage/app-secret" \
    --with-decryption --query Parameter.Value --output text
}

# Runs PostgreSQL client $1 (psql, pg_dump, pg_restore) on the stage's database, passing stdin.
stage_pg() {
  local tool=$1
  shift
  # The password reaches the container through its environment, never its command line.
  PGPASSWORD=$db_password docker run --rm -i -e PGPASSWORD \
    -v "$stage_dir/rds-ca.pem:/rds-ca.pem:ro" postgres:18-alpine "$tool" \
    -d "postgres://$db_name@$db_host:5432/$db_name?sslmode=verify-full&sslrootcert=/rds-ca.pem" "$@"
}

# Builds the Newses image from this checkout for stage_run, reads the stage's APP_SECRET for it,
# and exports your AWS credentials for it; temporary ones must outlast what it does.
stage_prepare_image() {
  stage_secret=$(stage_app_secret) || return
  echo "Building the Newses image from this checkout (a few minutes the first time)..."
  stage_image=$(docker build -q -f "$stage_root/docker/Dockerfile" "$stage_root") || return
  local credentials
  credentials=$(aws configure export-credentials --format env) || {
    echo 'cannot export your AWS credentials (needs AWS CLI v2)' >&2
    return 2
  }
  eval "$credentials"
}

# Runs the image from stage_prepare_image against the stage, its secrets in the environment:
# `stage_run [docker run options] -- <newses arguments>`.
stage_run() {
  local options=()
  while [ $# -gt 0 ] && [ "$1" != -- ]; do
    options+=("$1")
    shift
  done
  shift
  # Secrets reach the container through its environment, never its command line.
  PGPASSWORD=$db_password APP_SECRET=$stage_secret docker run --rm \
    ${options[@]+"${options[@]}"} \
    -v "$stage_dir/rds-ca.pem:/rds-ca.pem:ro" -e NODE_EXTRA_CA_CERTS=/rds-ca.pem \
    -e PGPASSWORD -e APP_SECRET -e BLOB_BUCKET="$blob_bucket" -e AWS_REGION \
    -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN \
    -e DATABASE_URL="postgres://$db_name@$db_host:5432/$db_name?sslmode=verify-full" \
    "$stage_image" "$@"
}

# The URLs of the stage's job queues and their dead-letter queues.
stage_queues() {
  local queue suffix
  for queue in feed-fetch feed-favicon entry-extract; do
    for suffix in '' -dlq; do
      aws sqs get-queue-url --queue-name "$stage_name-$queue$suffix" --query QueueUrl \
        --output text || return
    done
  done
}

# Snapshots the database instance, holding every stage, as <stage_name>-$1-<time>; prints its name.
stage_snapshot() {
  local snapshot
  snapshot="$stage_name-$1-$(date +%Y%m%d-%H%M%S)"
  echo "Snapshotting the database instance as $snapshot..." >&2
  aws rds create-db-snapshot --db-instance-identifier "$stage_prefix-db" \
    --db-snapshot-identifier "$snapshot" >/dev/null || return
  aws rds wait db-snapshot-available --db-snapshot-identifier "$snapshot" || return
  echo "$snapshot"
}

# Invokes the stage's migrate function: applies migrations, and creates the admin when there
# are no users.
stage_migrate() {
  local out error
  out=$(mktemp)
  error=$(aws lambda invoke --function-name "$stage_name-migrate" --cli-read-timeout 900 \
    --query FunctionError --output text "$out") || error='the invocation failed'
  [ "$error" = None ] || {
    echo "the migrate function failed: $(cat "$out")" >&2
    rm -f "$out"
    return 1
  }
  rm -f "$out"
}

# The functions that read or write the stage's data, except migrate: api and tick run on demand
# and on schedules; the others are fed by the job queues.
STAGE_CALLED_FUNCTIONS=(api tick)
STAGE_QUEUE_FUNCTIONS=(fetch favicon extract)

# Sets whether the queue-fed functions poll their queues: stage_poll true|false.
stage_poll() {
  local fn uuids uuid
  for fn in "${STAGE_QUEUE_FUNCTIONS[@]}"; do
    uuids=$(aws lambda list-event-source-mappings --function-name "$stage_name-$fn" \
      --query 'EventSourceMappings[].UUID' --output text) || return
    for uuid in $uuids; do
      if $1; then
        aws lambda update-event-source-mapping --uuid "$uuid" --enabled >/dev/null || return
      else
        aws lambda update-event-source-mapping --uuid "$uuid" --no-enabled >/dev/null || return
      fi
    done
  done
}

# Stops the stage's functions from starting: api and tick get no concurrency (requests fail),
# and the queue-fed functions stop polling (jobs wait in their queues). Running ones finish.
stage_freeze() {
  local fn
  for fn in "${STAGE_CALLED_FUNCTIONS[@]}"; do
    aws lambda put-function-concurrency --function-name "$stage_name-$fn" \
      --reserved-concurrent-executions 0 >/dev/null || return
  done
  stage_poll false
}

# Undoes stage_freeze.
stage_unfreeze() {
  local fn
  stage_poll true || return
  for fn in "${STAGE_CALLED_FUNCTIONS[@]}"; do
    aws lambda delete-function-concurrency --function-name "$stage_name-$fn" || return
  done
}
