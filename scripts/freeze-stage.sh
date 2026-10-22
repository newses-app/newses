#!/usr/bin/env bash
# Freezes an AWS stage so its data stops changing, or (--undo) unfreezes it: the api and tick
# functions get no concurrency, and the queue-fed functions stop polling their queues.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/freeze-stage.sh <dev|prod> [--undo]

  Stops the stage's api and tick functions (requests fail; schedules are skipped) and the
  fetch, favicon, and extract functions' queue polling (jobs wait). Running invocations finish.
  The migrate function keeps working.

  --undo  Unfreeze
EOF
}

die() {
  echo "freeze-stage: $*" >&2
  exit 2
}

stage='' undo=false
while [ $# -gt 0 ]; do
  case "$1" in
    --undo) undo=true; shift ;;
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

command -v aws >/dev/null || die 'the AWS CLI is not installed'
# shellcheck source=lib/deploy-config.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/deploy-config.sh"
# shellcheck source=lib/aws-stage.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/aws-stage.sh"
AWS_REGION=$(deploy_region)
export AWS_REGION
aws sts get-caller-identity >/dev/null || die 'no AWS credentials (set AWS_PROFILE or sign in)'
stage_prefix=$(deploy_prefix)
stage_name="$stage_prefix-$stage"

if $undo; then
  stage_unfreeze
  echo "Stage $stage is running."
else
  stage_freeze
  echo "Stage $stage is frozen. Unfreeze it with: scripts/freeze-stage.sh $stage --undo"
fi
