#!/usr/bin/env bash
# Sets up Windows code signing for the release pipeline with an existing Azure Artifact Signing
# (formerly Trusted Signing) account and certificate profile: an app registration for the
# pipeline, a client secret, and the Certificate Profile Signer role on the profile. Writes the
# values to desktop/electron-builder.env (local signed builds) and, with --ssm, to SSM.
# Identity validation, the account, and the certificate profile are set up in the Azure portal.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/windows-signing-setup.sh [--subscription ID] [--account NAME] [--profile NAME]
                                        [--app-name NAME] [--publisher NAME] [--years N]
                                        [--ssm] [--dry-run]

  --subscription ID  Azure subscription with the signing account (default: az's current one)
  --account NAME     Artifact Signing account (default: the only one in the subscription)
  --profile NAME     Certificate profile (default: the account's only active public-trust one)
  --app-name NAME    App registration for the release pipeline (default: <prefix>-release-signing)
  --publisher NAME   Publisher name (default: the CN of the profile's certificate)
  --years N          Client secret lifetime in years (default: 1)
  --ssm              Also store the values as SecureString parameters under
                     /<prefix>/release/windows-signing/ (AWS CLI credentials,
                     infra/deploy.config.json)
  --dry-run          Find the account, profile, and publisher, then stop before any change

Each run adds a new client secret, saves it, then removes the app registration's older ones.
Every step can be rerun.
EOF
}

die() {
  echo "windows-signing-setup: $*" >&2
  exit 2
}

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=lib/deploy-config.sh
. "$root/scripts/lib/deploy-config.sh"
# The deployment's resourcePrefix, else newses, so a rerun finds the app registration it made.
prefix=$(name_prefix)
env_file="$root/desktop/electron-builder.env"
ssm_path=/$prefix/release/windows-signing
provider=Microsoft.CodeSigning
# Renamed with the service; the role keeps its ID.
roles=('Artifact Signing Certificate Profile Signer' 'Trusted Signing Certificate Profile Signer')

subscription='' account='' profile='' app_name=$prefix-release-signing publisher='' years=1
ssm=false dry_run=false
while [ $# -gt 0 ]; do
  case "$1" in
    --subscription | --account | --profile | --app-name | --publisher | --years)
      [ $# -ge 2 ] || die "$1 needs a value"
      case "$1" in
        --subscription) subscription=$2 ;;
        --account) account=$2 ;;
        --profile) profile=$2 ;;
        --app-name) app_name=$2 ;;
        --publisher) publisher=$2 ;;
        --years) years=$2 ;;
      esac
      shift 2
      ;;
    --ssm) ssm=true; shift ;;
    --dry-run) dry_run=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[[ $years =~ ^[1-9][0-9]*$ ]] || die '--years takes a whole number of years'

command -v az >/dev/null || die 'needs the Azure CLI (az)'
# Azure requires MFA for management writes (the role assignment); older CLIs cannot satisfy it.
min_az=2.76.0
az_version=$(az version --query '"azure-cli"' -o tsv)
[ "$(printf '%s\n' "$min_az" "$az_version" | sort -V | head -1)" = "$min_az" ] ||
  die "needs Azure CLI $min_az or later for MFA on management changes (found $az_version): az upgrade"
if $ssm; then command -v aws >/dev/null || die '--ssm needs the AWS CLI (aws)'; fi
az account show >/dev/null 2>&1 || die 'sign in first: az login'
[ -z "$subscription" ] || az account set --subscription "$subscription"
tenant=$(az account show --query tenantId -o tsv)
echo "Subscription: $(az account show --query name -o tsv) (tenant $tenant)"

# Both tokens before any change, so a sign-in challenge (MFA) stops the run here, not halfway.
for scope in https://management.core.windows.net//.default https://graph.microsoft.com//.default; do
  az account get-access-token --scope "$scope" >/dev/null 2>&1 ||
    die "sign in again (with MFA if asked): az login --tenant $tenant --scope $scope"
done

# Azure requires MFA for management writes (the role assignment): the sign-in must have used it.
arm_scope=https://management.core.windows.net//.default
if ! $dry_run; then
  claims=$(az account get-access-token --scope "$arm_scope" --query accessToken -o tsv |
    cut -d. -f2 | tr '_-' '/+')
  while (( ${#claims} % 4 )); do claims+='='; done
  if ! base64 -d <<<"$claims" 2>/dev/null | grep -q '"amr":\[[^]]*"mfa"'; then
    mfa=$(printf '{"access_token":{"amr":{"values":["mfa"]}}}' | base64 | tr -d '\n')
    die "the Azure sign-in did not use MFA, which management changes need; sign in with:
  az logout && az login --tenant $tenant --scope $arm_scope --claims-challenge $mfa"
  fi
fi

step=''
trap 'echo "windows-signing-setup: failed while ${step:-starting}; rerunning is safe" >&2' ERR

# The newest stable API version the provider offers, else its newest preview.
api_version() {
  local versions
  versions=$(az provider show -n "$provider" \
    --query "resourceTypes[?resourceType=='$1'].apiVersions | [0]" -o tsv | tr '\t' '\n')
  [ -n "$versions" ] || die "$provider is not registered here: az provider register -n $provider"
  grep -v preview <<<"$versions" | sort -r | head -1 | grep . || sort -r <<<"$versions" | head -1
}
account_api=$(api_version codeSigningAccounts)
profile_api=$(api_version codeSigningAccounts/certificateProfiles)

step='finding the signing account'
filter=${account:+"?name=='$account'"}
mapfile -t accounts < <(az resource list --resource-type "$provider/codeSigningAccounts" \
  --query "[$filter].[id, name]" -o tsv)
if [ ${#accounts[@]} -eq 0 ]; then
  die "no Artifact Signing account${account:+ named $account}; create one, validate your identity, and add a public-trust certificate profile in the Azure portal"
fi
if [ ${#accounts[@]} -gt 1 ]; then
  die "several accounts; choose one with --account: $(cut -f2 <<<"$(printf '%s\n' "${accounts[@]}")" | paste -sd ' ')"
fi
IFS=$'\t' read -r account_id account <<<"${accounts[0]}"
endpoint=$(az resource show --ids "$account_id" --api-version "$account_api" \
  --query properties.accountUri -o tsv)
echo "Account: $account ($endpoint)"

step='finding the certificate profile'
mapfile -t profiles < <(az rest --method get \
  --url "https://management.azure.com$account_id/certificateProfiles?api-version=$profile_api" \
  --query "value[?properties.status=='Active' && properties.profileType=='PublicTrust'${profile:+ && name=='$profile'}].[id, name, properties.certificates[0].subjectName]" \
  -o tsv)
if [ ${#profiles[@]} -eq 0 ]; then
  die "no active public-trust certificate profile${profile:+ named $profile} in $account"
fi
if [ ${#profiles[@]} -gt 1 ]; then
  die "several profiles; choose one with --profile: $(cut -f2 <<<"$(printf '%s\n' "${profiles[@]}")" | paste -sd ' ')"
fi
IFS=$'\t' read -r profile_id profile subject <<<"${profiles[0]}"
echo "Profile: $profile (${subject:-no certificate issued yet})"

# The publisher must match the certificate's common name, or electron-updater refuses updates.
if [ -z "$publisher" ]; then
  [[ ${subject:-} =~ (^|,[[:space:]]*)CN=([^,]+) ]] ||
    die 'cannot read the CN from the certificate subject; pass --publisher'
  publisher=${BASH_REMATCH[2]}
fi
echo "Publisher: $publisher"

role=''
for name in "${roles[@]}"; do
  role=$(az role definition list --name "$name" --query '[0].name' -o tsv)
  [ -z "$role" ] || break
done
[ -n "$role" ] || die "no Certificate Profile Signer role found (tried: ${roles[*]})"

if $dry_run; then
  echo "Dry run: would set up app registration $app_name with the signer role on $profile."
  exit 0
fi

# App registration and service principal for the release pipeline.
step='setting up the app registration'
app_id=$(az ad app list --display-name "$app_name" --query '[0].appId' -o tsv)
if [ -z "$app_id" ]; then
  app_id=$(az ad app create --display-name "$app_name" --sign-in-audience AzureADMyOrg \
    --query appId -o tsv)
  echo "Created app registration $app_name ($app_id)"
else
  echo "App registration: $app_name ($app_id)"
fi
sp_id=$(az ad sp show --id "$app_id" --query id -o tsv 2>/dev/null ||
  az ad sp create --id "$app_id" --query id -o tsv)

step='granting the signer role'
# Assigned first: a failing command inside a test would not stop the script.
assigned=$(az role assignment list --assignee "$sp_id" --scope "$profile_id" --role "$role" \
  --query 'length(@)' -o tsv)
if [ "$assigned" = 0 ]; then
  az role assignment create --assignee-object-id "$sp_id" \
    --assignee-principal-type ServicePrincipal --role "$role" --scope "$profile_id" \
    --only-show-errors >/dev/null
  echo "Granted the signer role on $profile (may take a few minutes to apply)"
else
  echo "Signer role already granted on $profile"
fi

# The new secret is added beside the old ones, which are removed only once it is saved, so a
# failure here leaves the pipeline's current secret working.
step='creating the client secret'
old_secrets=$(az ad app credential list --id "$app_id" --query '[].keyId' -o tsv)
secret=$(az ad app credential reset --id "$app_id" --append --display-name "$prefix-release" \
  --years "$years" --query password -o tsv --only-show-errors)
echo "New client secret, valid for $years year(s)"

values=(
  "AZURE_TENANT_ID tenant-id $tenant"
  "AZURE_CLIENT_ID client-id $app_id"
  "AZURE_CLIENT_SECRET client-secret $secret"
  "WIN_SIGNING_ENDPOINT endpoint $endpoint"
  "WIN_SIGNING_ACCOUNT_NAME account-name $account"
  "WIN_SIGNING_PROFILE_NAME profile-name $profile"
  "WIN_PUBLISHER_NAME publisher-name $publisher"
)

step="writing $env_file"
(
  umask 077
  for entry in "${values[@]}"; do
    read -r var _ value <<<"$entry"
    printf '%s=%s\n' "$var" "$value"
  done >"$env_file"
)
echo "Wrote $env_file (gitignored)"

if $ssm; then
  step='storing the SSM parameters'
  region=$(deploy_region)
  # Values go through a private file so the secret never appears in a process list.
  request=$(mktemp)
  trap 'rm -f "$request"' EXIT
  chmod 600 "$request"
  for entry in "${values[@]}"; do
    read -r _ key value <<<"$entry"
    printf '{"Name":"%s/%s","Type":"SecureString","Overwrite":true,"Value":"%s"}' \
      "$ssm_path" "$key" "$(sed 's/["\\]/\\&/g' <<<"$value")" >"$request"
    aws ssm put-parameter --region "$region" --cli-input-json "file://$request" >/dev/null
  done
  echo "Stored ${#values[@]} SecureString parameters under $ssm_path"
fi

step='removing the old client secrets'
for key in $old_secrets; do
  az ad app credential delete --id "$app_id" --key-id "$key" --only-show-errors
done
[ -z "$old_secrets" ] || echo "Removed $(wc -w <<<"$old_secrets") old client secret(s)"
