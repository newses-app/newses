#!/usr/bin/env bash
# Stores the deployment config (infra/deploy.config.json, or the file NEWSES_DEPLOY_CONFIG names)
# in the SSM parameter /<resourcePrefix>/deploy-config, which the pipelines' synth step reads.
# Checks it against the config's schema and shows how it differs from the stored copy; only
# --apply stores it.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/store-deploy-config.sh [--apply]

Checks infra/deploy.config.json (or the file NEWSES_DEPLOY_CONFIG names) against the deployment
config's schema, then shows how it differs from the copy in the SSM parameter
/<resourcePrefix>/deploy-config, in the config's region, which the deploy and release pipelines
read when they synthesise.

  --apply  Store the file in the parameter

Every run can be repeated. The pipelines use the stored config from their next run on. Needs Node
24 with the workspace installed, and AWS CLI credentials for the config's account.
EOF
}

die() {
  echo "store-deploy-config: $*" >&2
  exit 2
}

apply=false
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) apply=true; shift ;;
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

echo
if [ -z "$stored" ]; then
  echo 'Not stored yet.'
elif [ "$(normalise <<<"$stored")" = "$local_json" ]; then
  echo 'The stored config matches the file; nothing to change.'
  exit 0
else
  diff -u --label "stored $parameter" --label "$file" <(normalise <<<"$stored") - \
    <<<"$local_json" || true
fi

if ! $apply; then
  echo
  echo 'Nothing changed: rerun with --apply to store the file.'
  exit 0
fi

"${ssm[@]}" put-parameter --name "$parameter" --type String --overwrite \
  --value "file://$file" >/dev/null
echo
echo "Stored. The pipelines read it from their next run on: push, or release a change in the"
echo "deploy pipelines ($(node -e '
  const config = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  console.log(config.stages.map((s) => `${config.resourcePrefix}-${s.name}`).join(", "));
' "$file"))."
