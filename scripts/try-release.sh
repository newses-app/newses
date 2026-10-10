#!/usr/bin/env bash
# Runs the dev release pipeline's build legs on the local working tree, without a commit or a
# tag: uploads the tree to the release stack's scratch bucket and starts the same CodeBuild
# projects with it as the source. The publish leg is a dry run unless --publish is given.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/try-release.sh [--leg all|linux|windows|publish] [--tag TAG] [--publish]

  --leg LEG   Run one leg (default: all, i.e. linux and windows in parallel, then publish)
  --tag TAG   Release tag to build as (default: v0.0.1-try.<time>); a later --leg publish run
              with the same tag reuses the build legs' files
  --publish   Really publish to reader-dev.example.com/downloads/ (default: a dry run)

Checks the buildspecs first: bash syntax for the Linux legs, ASCII for the Windows leg.
Always targets the dev stage. Needs AWS CLI credentials, git, zip, and python3 with PyYAML.
EOF
}

die() {
  echo "try-release: $*" >&2
  exit 2
}

region=us-east-2
stack=rss-reader-dev-release
leg=all tag='' dry_run=true
while [ $# -gt 0 ]; do
  case "$1" in
    --leg | --tag)
      [ $# -ge 2 ] || die "$1 needs a value"
      if [ "$1" = --leg ]; then leg=$2; else tag=$2; fi
      shift 2
      ;;
    --publish) dry_run=false; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
case "$leg" in all | linux | windows | publish) ;; *) die '--leg takes all, linux, windows, or publish' ;; esac
# Dev releases are prereleases; versionCode 0 would be refused, hence 0.0.1.
[ -n "$tag" ] || tag="v0.0.1-try.$(date +%s)"
[[ $tag == v*-* ]] || die "dev releases need a prerelease tag (v1.2.3-x): $tag"
[[ $tag != v0.0.0-* ]] || die "Android refuses versionCode 0; start at v0.0.1: $tag"

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"

# A failed build costs minutes; a syntax error or a non-ASCII byte is found here for free.
python3 - <<'EOF'
import subprocess, sys, yaml
bad = 0
for path in ["infra/buildspec/release-linux.yml", "infra/buildspec/release-publish.yml"]:
    for phase, body in yaml.safe_load(open(path))["phases"].items():
        for i, cmd in enumerate(body.get("commands") or []):
            r = subprocess.run(["bash", "-n"], input=cmd, text=True, capture_output=True)
            if r.returncode:
                bad += 1
                print(f"{path} {phase}[{i}]: {r.stderr.strip()}", file=sys.stderr)
path = "infra/buildspec/release-windows.yml"
for phase, body in yaml.safe_load(open(path, encoding="utf-8"))["phases"].items():
    for i, cmd in enumerate(body.get("commands") or []):
        for n, line in enumerate(cmd.splitlines(), 1):
            if any(ord(ch) > 127 for ch in line):
                bad += 1
                print(f"{path} {phase}[{i}] line {n}: not ASCII: {line.strip()[:80]}", file=sys.stderr)
if bad:
    sys.exit(f"try-release: {bad} problem(s) in the buildspecs")
print("Buildspecs checked")
EOF

outputs=$(aws cloudformation describe-stacks --region "$region" --stack-name "$stack" \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output text) ||
  die "cannot read $stack; is it deployed?"
output() { awk -v key="$1" '$1 == key { print $2 }' <<<"$outputs"; }
bucket=$(output ScratchBucket)
declare -A projects=(
  [linux]=$(output LinuxProject)
  [windows]=$(output WindowsProject)
  [publish]=$(output PublishProject)
)

# Tracked and untracked files, without ignored ones (signing env files, builds); zip keeps
# gradlew's executable bit.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git ls-files -co --exclude-standard -z | xargs -0 zip -q "$work/source.zip"
key="try/$tag/source.zip"
echo "Uploading the working tree ($(du -h "$work/source.zip" | cut -f1)) to s3://$bucket/$key"
aws s3 cp --region "$region" --only-show-errors "$work/source.zip" "s3://$bucket/$key"
echo "tag=$tag leg=$leg dry_run=$dry_run"

# These are pipeline projects, so the source and artifacts are overridden for a direct run.
start() {
  local id
  id=$(aws codebuild start-build --region "$region" --project-name "${projects[$1]}" \
    --source-type-override S3 --source-location-override "$bucket/$key" \
    --artifacts-override type=NO_ARTIFACTS \
    --environment-variables-override \
    "name=RELEASE_TAG,value=$tag,type=PLAINTEXT" "name=DRY_RUN,value=$dry_run,type=PLAINTEXT" \
    --query build.id --output text)
  echo "Started $1: https://$region.console.aws.amazon.com/codesuite/codebuild/projects/${projects[$1]}/history?region=$region" >&2
  echo "$id"
}

# Waits for the builds; fails if any did not succeed.
wait_for() {
  local status
  while :; do
    status=$(aws codebuild batch-get-builds --region "$region" --ids "$@" \
      --query 'builds[].buildStatus' --output text)
    grep -q IN_PROGRESS <<<"$status" || break
    sleep 30
  done
  echo "Finished: $status"
  ! tr '\t' '\n' <<<"$status" | grep -qv SUCCEEDED
}

if [ "$leg" != all ]; then
  wait_for "$(start "$leg")"
  exit
fi
wait_for "$(start linux)" "$(start windows)" || die 'a build leg failed; not publishing'
wait_for "$(start publish)"
