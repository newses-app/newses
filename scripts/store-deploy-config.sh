#!/usr/bin/env bash
# Stores the deployment config (infra/deploy.config.json, or the file NEWSES_DEPLOY_CONFIG names)
# in the SSM parameter /<resourcePrefix>/deploy-config, which the pipelines' synth step reads.
# Checks it against the config's schema and shows how it differs from the stored copy, plugins
# per stage; only --apply stores it, and --release starts a stage's deploy pipeline after.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/store-deploy-config.sh [--apply] [--release STAGE]

Checks infra/deploy.config.json (or the file NEWSES_DEPLOY_CONFIG names) against the deployment
config's schema, then shows how it differs from the copy in the SSM parameter
/<resourcePrefix>/deploy-config, in the config's region, which the deploy and release pipelines
read when they synthesise, and which plugins each stage adds, changes, or removes.

  --apply          Store the file in the parameter
  --release STAGE  Then start the stage's deploy pipeline (dev or prod), which deploys the stored
                   config, its plugins too, from the stage's branch; needs --apply when the file
                   differs from the stored copy

Every run can be repeated. The pipelines use the stored config from their next run on. Needs Node
24 with the workspace installed, and AWS CLI credentials for the config's account.
EOF
}

die() {
  echo "store-deploy-config: $*" >&2
  exit 2
}

apply=false release=''
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) apply=true; shift ;;
    --release)
      [ $# -ge 2 ] || die '--release needs a stage'
      release=$2
      shift 2
      ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

command -v aws >/dev/null || die 'needs the AWS CLI (aws)'
command -v node >/dev/null || die 'needs Node'
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=lib/deploy-config.sh
. "$root/scripts/lib/deploy-config.sh"
file=$(deploy_config_file) || exit 2
file=$(cd "$(dirname "$file")" && pwd)/$(basename "$file")

# The infra package's own schema, so the check matches what the pipelines' synth accepts.
(cd "$root/infra" && NEWSES_DEPLOY_CONFIG=$file node --input-type=module -e '
  try {
    await import("./src/deploy-config.ts");
  } catch (error) {
    if (!Array.isArray(error?.issues)) throw error;
    console.error(`${process.env.NEWSES_DEPLOY_CONFIG} does not match the deployment config schema:`);
    for (const issue of error.issues) {
      console.error(`  ${issue.path.join(".") || "(top level)"}: ${issue.message}`);
    }
    process.exit(2);
  }
') || exit 2

prefix=$(deploy_prefix)
region=$(deploy_region)
if [ -n "$release" ]; then
  stage_domain "$release" >/dev/null || exit 2
fi
parameter=/$prefix/deploy-config
ssm=(aws ssm --region "$region")

account=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) ||
  die 'no AWS credentials (set AWS_PROFILE or sign in)'
expected=$(deploy_value account)
[ "$expected" = "$account" ] ||
  die "signed in to account $account, but the deployment config is for $expected"
echo "Config: $file"
echo "Parameter: $parameter in $region, account $account"

# Both sides formatted alike, so the diff shows changed values rather than whitespace.
normalise() { node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(0, "utf8")), null, 2))'; }
local_json=$(normalise <"$file")
# Only a missing parameter counts as not stored; any other failure stops the run.
if ! stored=$("${ssm[@]}" get-parameter --name "$parameter" --query Parameter.Value \
  --output text 2>&1); then
  grep -q ParameterNotFound <<<"$stored" || die "could not read $parameter: $stored"
  stored=''
fi

# Starts the stage's deploy pipeline, which reads the stored config when it synthesises.
start_release() {
  local pipeline=$prefix-$release execution
  execution=$(aws codepipeline start-pipeline-execution --region "$region" --name "$pipeline" \
    --query pipelineExecutionId --output text) || die "could not start $pipeline"
  echo
  echo "Started $pipeline (execution $execution); it deploys the stored config."
}

echo
if [ -z "$stored" ]; then
  echo 'Not stored yet.'
elif [ "$(normalise <<<"$stored")" = "$local_json" ]; then
  echo 'The stored config matches the file; nothing to change.'
  [ -z "$release" ] || start_release
  exit 0
else
  diff -u --label "stored $parameter" --label "$file" <(normalise <<<"$stored") - \
    <<<"$local_json" || true
fi

changes=$(node "$root/infra/src/plugin-changes.ts" <(printf '%s' "$stored") "$file")
if [ -n "$changes" ]; then
  echo
  echo 'Plugins:'
  sed 's/^/  /' <<<"$changes"
  echo 'Plugins run inside the server with access to its data: install only those you trust.'
fi

if ! $apply; then
  echo
  echo 'Nothing changed: rerun with --apply to store the file.'
  [ -z "$release" ] || die '--release deploys the stored config: add --apply to store this one first'
  exit 0
fi

"${ssm[@]}" put-parameter --name "$parameter" --type String --overwrite \
  --value "file://$file" >/dev/null
echo
if [ -n "$release" ]; then
  echo 'Stored.'
  start_release
  exit 0
fi
echo "Stored. The pipelines read it from their next run on: push, rerun with --release STAGE, or"
echo "release a change in the deploy pipelines ($(node -e '
  const config = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  console.log(config.stages.map((s) => `${config.resourcePrefix}-${s.name}`).join(", "));
' "$file"))."
