#!/usr/bin/env bash
# Imports a TTRSS database dump into the local Docker stack or an AWS stage: restores the dump
# into a throwaway PostgreSQL container, runs a dry run, asks, imports, and saves the report.
# See docs/migration-ttrss.md.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/import-ttrss.sh <dump> [--aws dev|prod] [--users a,b] [--since YYYY-MM-DD]
                               [--force] [--dry-run] [--yes]

  <dump>         pg_dump custom-format file (-Fc), .sql, or .sql.gz of the TTRSS database
  --aws STAGE    Import into that AWS stage (AWS CLI credentials, infra/deploy.config.json);
                 default: the Docker stack in docker/
  --users a,b    Import only these TTRSS logins
  --since DATE   Skip entries older than DATE unless kept (starred, published, ...)
  --force        Re-import into users who have used this instance since their last import
  --dry-run      Stop after the dry run
  --yes          Import without asking after the dry run
EOF
}

die() {
  echo "import-ttrss: $*" >&2
  exit 2
}

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
compose=(docker compose -f "$root/docker/compose.yaml")

dump='' stage='' dry_only=false yes=false
pass=()
while [ $# -gt 0 ]; do
  case "$1" in
    --aws) stage=${2:-}; shift 2 || die '--aws needs a stage' ;;
    --users | --since) [ $# -ge 2 ] || die "$1 needs a value"; pass+=("$1" "$2"); shift 2 ;;
    --force) pass+=(--force); shift ;;
    --dry-run) dry_only=true; shift ;;
    --yes) yes=true; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) usage >&2; die "unknown option $1" ;;
    *) [ -z "$dump" ] || die 'only one dump file'; dump=$1; shift ;;
  esac
done
[ -n "$dump" ] || { usage >&2; exit 2; }
[ -r "$dump" ] || die "cannot read $dump"
case "$stage" in '' | dev | prod) ;; *) die "--aws takes dev or prod, not $stage" ;; esac

docker info >/dev/null 2>&1 || die 'Docker is not running'
if [ -z "$stage" ]; then
  target='the Docker stack'
  label=docker
  [ -n "$("${compose[@]}" ps --status running -q server)" ] ||
    die "the Docker stack is not running; start it with: docker compose -f docker/compose.yaml up -d"
else
  target="AWS stage $stage"
  label="aws-$stage"
  command -v aws >/dev/null || die 'the AWS CLI is not installed'
  # shellcheck source=lib/deploy-config.sh
  . "$root/scripts/lib/deploy-config.sh"
  # shellcheck source=lib/aws-stage.sh
  . "$root/scripts/lib/aws-stage.sh"
  AWS_REGION=$(deploy_region)
  export AWS_REGION
  aws sts get-caller-identity >/dev/null || die 'no AWS credentials (set AWS_PROFILE or sign in)'
fi

# The source: a throwaway PostgreSQL with the dump restored, removed on exit.
name="newses-import-$$"
tmp=$(mktemp -d)
# shellcheck disable=SC2329 # run by the EXIT trap
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker network rm "$name" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

echo "Starting a temporary database for the dump..."
docker network create "$name" >/dev/null
docker run -d --name "$name" --network "$name" -e POSTGRES_HOST_AUTH_METHOD=trust \
  -e POSTGRES_DB=ttrss postgres:18-alpine >/dev/null
for _ in $(seq 60); do
  docker exec "$name" pg_isready -q -h 127.0.0.1 -U postgres -d ttrss && break
  sleep 1
done
docker exec "$name" pg_isready -q -h 127.0.0.1 -U postgres -d ttrss ||
  die 'the temporary database did not start'

echo "Restoring $dump ($(du -h "$dump" | cut -f1))..."
restored=0
if [ "$(head -c 5 "$dump")" = PGDMP ]; then
  docker exec -i "$name" pg_restore -U postgres -d ttrss --no-owner --no-acl <"$dump" || restored=$?
elif [[ "$dump" == *.gz ]]; then
  gunzip -c "$dump" | docker exec -i "$name" psql -q -U postgres -d ttrss >/dev/null || restored=$?
else
  docker exec -i "$name" psql -q -U postgres -d ttrss <"$dump" >/dev/null || restored=$?
fi
[ "$restored" -eq 0 ] ||
  echo "Warning: the restore reported errors (above); the dry run shows whether anything is missing." >&2
source_url="postgres://postgres@$name:5432/ttrss"

if [ -z "$stage" ]; then
  # The stack's server reaches the source over the stack's network.
  db_container=$("${compose[@]}" ps -q db)
  stack_network=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' \
    "$db_container" | cut -d' ' -f1)
  docker network connect "$stack_network" "$name"
  run_import() {
    "${compose[@]}" exec -T server newses cli import-ttrss --source "$source_url" "$@"
  }
else
  aws_stage "$stage" "$tmp"
  prefix=$stage_prefix
  # Articles past retention go to the stage's archive in its blob bucket, when the stage has it on.
  archive=$(aws lambda get-function-configuration --function-name "$prefix-$stage-tick" \
    --query 'Environment.Variables.ARCHIVE_ENABLED' --output text)
  [ "$archive" = true ] || archive=false
  if $archive; then
    [ -n "$blob_bucket" ] || die "the $stage data stack has no BlobBucket output; deploy it first"
    echo "Archive: on, in $blob_bucket"
  else
    echo "Archive: off; entries past retention are skipped"
  fi
  # The import writes the archive with your credentials.
  stage_prepare_image || exit 2
  echo "Connecting to $db_name on $db_host..."
  run_import() {
    stage_run --network "$name" -e ARCHIVE_ENABLED="$archive" -- \
      cli import-ttrss --source "$source_url" "$@"
  }
fi

echo
echo "== Dry run: nothing is written"
status=0
run_import --dry-run ${pass[@]+"${pass[@]}"} || status=$?
if [ "$status" -ne 0 ]; then
  echo "The dry run did not succeed (status $status); nothing was imported." >&2
  exit "$status"
fi
$dry_only && exit 0

if ! $yes; then
  [ -t 0 ] || die 'not a terminal: pass --yes to import without asking'
  read -r -p "Import into $target? [y/N] " answer
  [[ "$answer" =~ ^[Yy] ]] || { echo 'Nothing imported.'; exit 0; }
fi

report="ttrss-import-$label-$(date +%Y%m%d-%H%M%S).txt"
echo
echo "== Import into $target"
status=0
(umask 077 && run_import ${pass[@]+"${pass[@]}"} >"$report" 2>&1) || status=$?
sed -E 's/(temporary password) [^ ]+/\1 (in the report file)/' "$report"
echo
echo "Report saved to $report. It holds the new users' temporary passwords: hand them out within 7 days, when they expire, then delete it."
exit "$status"
