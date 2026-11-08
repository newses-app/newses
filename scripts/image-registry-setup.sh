#!/usr/bin/env bash
# Creates the ECR Public repository the release pipelines publish the server image to, or updates
# its gallery listing, and prints its URI for the stages' imageRepository in the deployment config.
# Also creates the KMS key the publish legs sign the image with (alias/<prefix>-image-signing, in
# the deployment's region) and prints its public key. ECR Public lives in us-east-1 whatever the
# deployment's region. A custom registry alias is claimed in the ECR Public console.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/image-registry-setup.sh [--name NAME] [--dry-run]

  --name NAME  Repository name (default: the deployment's resourcePrefix, else newses)
  --dry-run    Show the registry alias, the repository, and the signing key, then stop before
               any change

Creates the repository with its gallery listing (description, logo, about and usage text,
architectures), or updates the listing of an existing one, and the image signing key unless it
exists; every run can be repeated. Needs AWS CLI credentials for the deployment's account
(infra/deploy.config.json), and openssl.
EOF
}

die() {
  echo "image-registry-setup: $*" >&2
  exit 2
}

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=lib/deploy-config.sh
. "$root/scripts/lib/deploy-config.sh"
prefix=$(name_prefix)
logo=$root/web/public/icon-512.png

name=$prefix dry_run=false
while [ $# -gt 0 ]; do
  case "$1" in
    --name)
      [ $# -ge 2 ] || die "$1 needs a value"
      name=$2
      shift 2
      ;;
    --dry-run) dry_run=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[[ $name =~ ^[a-z0-9]+([._-][a-z0-9]+)*(/[a-z0-9]+([._-][a-z0-9]+)*)*$ ]] ||
  die "not a repository name: $name (lowercase letters, digits, and . _ - /)"

command -v aws >/dev/null || die 'needs the AWS CLI (aws)'
command -v node >/dev/null || die 'needs Node'
command -v openssl >/dev/null || die 'needs openssl'
ecr=(aws ecr-public --region us-east-1)
region=$(deploy_region) || die 'no region in infra/deploy.config.json'
kms=(aws kms --region "$region")
key_alias=alias/$prefix-image-signing

account=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) ||
  die 'no AWS credentials (set AWS_PROFILE or sign in)'
expected=$(deploy_value account 2>/dev/null || true)
[ -z "$expected" ] || [ "$expected" = "$account" ] ||
  die "signed in to account $account, but the deployment config is for $expected"
echo "Account: $account"

# Every account has a registry with a generated alias once it uses ECR Public; the console
# replaces it with a custom one.
alias=$("${ecr[@]}" describe-registries \
  --query 'registries[0].aliases[?primaryRegistryAlias].name | [0]' --output text 2>/dev/null || true)
[ "$alias" != None ] || alias=''
echo "Registry alias: ${alias:-none yet (ECR Public creates one with the first repository)}"

uri=$("${ecr[@]}" describe-repositories --repository-names "$name" \
  --query 'repositories[0].repositoryUri' --output text 2>/dev/null || true)
echo "Repository: ${uri:-$name, not created yet}"

key=$("${kms[@]}" describe-key --key-id "$key_alias" --query KeyMetadata.Arn --output text \
  2>/dev/null || true)
echo "Signing key: ${key:-$key_alias in $region, not created yet}"

if $dry_run; then
  echo "Dry run: would ${uri:+update the listing of}${uri:-create} $name${key:+.}${key:- and create $key_alias.}"
  exit 0
fi

step=''
trap 'echo "image-registry-setup: failed while ${step:-starting}; rerunning is safe" >&2' ERR

if [ -z "$uri" ]; then
  step='creating the repository'
  uri=$("${ecr[@]}" create-repository --repository-name "$name" --tags "Key=project,Value=$prefix" \
    --query 'repository.repositoryUri' --output text)
  echo "Created $uri"
fi

# The listing goes through a file: the logo is too large for an argument.
step='updating the gallery listing'
catalog=$(mktemp)
trap 'rm -f "$catalog"' EXIT
URI=$uri LOGO=$logo node -e '
  const { readFileSync } = require("node:fs");
  console.log(JSON.stringify({
    description: "Newses: a self-hosted RSS reader. One image runs the server, the worker, and database migrations.",
    architectures: ["x86-64", "ARM 64"],
    operatingSystems: ["Linux"],
    logoImageBlob: readFileSync(process.env.LOGO).toString("base64"),
    aboutText: [
      "# Newses",
      "",
      "A self-hosted RSS reader with a web app, desktop and Android apps, and the Tiny Tiny RSS and Google Reader APIs for third-party clients.",
      "",
      "- Documentation: https://newses.app",
      "- License: AGPL-3.0-or-later; each image names its source in the `org.opencontainers.image.source` label.",
    ].join("\n"),
    usageText: [
      "Install with the compose file and sample configuration from the release, as the self-hosting guide shows: https://newses.app/guide/self-hosting",
      "",
      "The command picks the role: `server` (default), `worker`, `migrate`, or `cli`. Version tags (`1.2.3`) never move; `1.2`, `1`, and `latest` follow the newest release, and `next` the newest prerelease.",
      "",
      "Each version is signed with cosign; verify it with the `cosign.pub` its release publishes beside the compose file.",
      "",
      "```sh",
      `docker pull ${process.env.URI}:latest`,
      `cosign verify --key cosign.pub ${process.env.URI}:latest`,
      "```",
    ].join("\n"),
  }));
' >"$catalog"
"${ecr[@]}" put-repository-catalog-data --repository-name "$name" \
  --catalog-data "file://$catalog" >/dev/null
echo "Gallery listing updated"

# ECDSA P-256, cosign's default; only the release stacks' publish roles may sign with it.
if [ -z "$key" ]; then
  step='creating the signing key'
  key=$("${kms[@]}" create-key --key-spec ECC_NIST_P256 --key-usage SIGN_VERIFY \
    --description "Signs the $prefix server image (cosign)" --tags "TagKey=project,TagValue=$prefix" \
    --query KeyMetadata.Arn --output text)
  "${kms[@]}" create-alias --alias-name "$key_alias" --target-key-id "$key"
  echo "Created $key_alias ($key)"
fi
step='reading the public key'
public_key=$("${kms[@]}" get-public-key --key-id "$key_alias" --query PublicKey --output text |
  openssl base64 -d -A | openssl pkey -pubin -inform DER)

cat <<EOF

The image's cosign public key, which each release also publishes beside its compose file:
$public_key

Set "imageRepository": "$uri" on each stage that publishes the image in
infra/deploy.config.json, then store the config (AGENTS.md). Once a custom registry alias is
approved, images are also under its URI and the default alias's keeps working: rerun this script
and update the config to publish under the custom one.
EOF
