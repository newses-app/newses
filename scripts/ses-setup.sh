#!/usr/bin/env bash
# Shows the account's SES status in the deployment's region and each mail stage's domain identity,
# which the stage's deploy creates, and what the options would change: asking AWS for production
# access (--request-production-access) and adding test recipients while the account is in the SES
# sandbox (--test-recipient). Only --apply makes the changes.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/ses-setup.sh [--request-production-access [--website-url URL] [--use-case TEXT]
                              [--contact ADDRESS]...] [--test-recipient ADDRESS]... [--apply]

Shows the account's SES status in the deployment's region (sandbox or production access, a
pending review, the sending quota), each stage that sets mail with its domain identity
(verification, DKIM, MAIL FROM), and the test recipients; then what the options below
would change, which only --apply makes.

  --request-production-access
                           Asks AWS to take the account out of the SES sandbox, so the mail
                           stages can email any address: transactional mail, the website and use
                           case below. Account-wide in the region, not per stage. Skipped once
                           granted or while a review is pending; AWS answers by email to the
                           account's contacts
  --website-url URL        The website in the request (default: https:// and the prod stage's
                           domain, else the first mail stage's)
  --use-case TEXT          The use case in the request (default: a description of Newses's mail)
  --contact ADDRESS        Another address AWS sends its answer to (repeatable)
  --test-recipient ADDRESS Lets the stages email ADDRESS while the account is in the sandbox; SES
                           mails it a link to follow first (repeatable; skipped when ADDRESS is
                           already a test recipient)
  --apply                  Make the changes the options describe

Every run can be repeated. Needs AWS CLI credentials for the deployment's account
(infra/deploy.config.json).
EOF
}

die() {
  echo "ses-setup: $*" >&2
  exit 2
}

email_pattern='^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'

request_access=false website_url='' use_case='' apply=false
contacts=() recipients=()
while [ $# -gt 0 ]; do
  case "$1" in
    --request-production-access) request_access=true; shift ;;
    --website-url | --use-case | --contact | --test-recipient)
      [ $# -ge 2 ] || die "$1 needs a value"
      case "$1" in
        --website-url) website_url=$2 ;;
        --use-case) use_case=$2 ;;
        --contact) contacts+=("$2") ;;
        --test-recipient) recipients+=("$2") ;;
      esac
      shift 2
      ;;
    --apply) apply=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
for address in ${contacts[@]+"${contacts[@]}"} ${recipients[@]+"${recipients[@]}"}; do
  [[ $address =~ $email_pattern ]] || die "not an email address: $address"
done
$request_access || [ -z "$website_url$use_case${contacts[*]-}" ] ||
  die '--website-url, --use-case, and --contact go with --request-production-access'
[ -z "$website_url" ] || [[ $website_url =~ ^https?://[^[:space:]]+$ ]] ||
  die "not a website URL: $website_url"
[ "${#use_case}" -le 5000 ] || die 'the use case is longer than 5000 characters'

command -v aws >/dev/null || die 'needs the AWS CLI (aws)'
command -v node >/dev/null || die 'needs Node'
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=lib/deploy-config.sh
. "$root/scripts/lib/deploy-config.sh"
config=$(deploy_config_file) || exit 2
region=$(deploy_region) || die 'no region in infra/deploy.config.json'
ses=(aws sesv2 --region "$region")

account=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) ||
  die 'no AWS credentials (set AWS_PROFILE or sign in)'
expected=$(deploy_value account 2>/dev/null || true)
[ -z "$expected" ] || [ "$expected" = "$account" ] ||
  die "signed in to account $account, but the deployment config is for $expected"
echo "Account: $account, SES in $region"

# "name domain" for each stage that sets mail, the prod stage first.
mail_stages=$(node -e '
  const config = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const stages = config.stages.filter((s) => s.mail === true);
  stages.sort((a, b) => (b.name === "prod") - (a.name === "prod"));
  for (const s of stages) console.log(`${s.name} ${s.domainName}`);
' "$config")

# Account status: production access, the review of a request, sending, and the daily quota.
status=$("${ses[@]}" get-account --query \
  '[ProductionAccessEnabled, Details.ReviewDetails.Status, SendingEnabled, SendQuota.Max24HourSend, SendQuota.SentLast24Hours]' \
  --output text) || die "could not read the account's SES status in $region"
read -r production_access review sending quota sent <<<"$status"
if [ "$production_access" = True ]; then
  echo "Production access: granted"
else
  echo "Production access: no, the account is in the sandbox (it emails only test recipients)"
fi
[ "$review" = None ] || echo "Production access review: $review"
echo "Sending: $([ "$sending" = True ] && echo enabled || echo paused), $sent of $quota sent in the last 24 hours"

echo
if [ -z "$mail_stages" ]; then
  echo 'No stage sets mail in infra/deploy.config.json.'
else
  while read -r name domain; do
    status=$("${ses[@]}" get-email-identity --email-identity "$domain" --query \
      '[VerificationStatus, DkimAttributes.Status, MailFromAttributes.MailFromDomainStatus]' \
      --output text 2>/dev/null || true)
    if [ -z "$status" ]; then
      echo "Stage $name: $domain, no identity yet (the stage's next deploy creates it)"
    else
      read -r verification dkim mail_from <<<"$status"
      echo "Stage $name: $domain, verification $verification, DKIM $dkim, MAIL FROM $mail_from"
    fi
  done <<<"$mail_stages"
fi

verified=$("${ses[@]}" list-email-identities \
  --query "EmailIdentities[?IdentityType=='EMAIL_ADDRESS'].[IdentityName, VerificationStatus]" \
  --output text)
if [ -n "$verified" ]; then
  echo
  echo 'Test recipients:'
  while read -r address status; do echo "  $address ($status)"; done <<<"$verified"
fi

# What the options would do.
request=false
if $request_access; then
  if [ "$production_access" = True ]; then
    echo
    echo 'Production access is already granted; not asking again.'
  elif [ "$review" = PENDING ]; then
    echo
    echo 'A production access request is already under review; AWS answers it by email.'
  else
    request=true
    [ -n "$mail_stages" ] || [ -n "$website_url" ] ||
      die 'no stage sets mail: set "mail": true on one, or pass --website-url'
    [ -n "$website_url" ] || website_url=https://$(head -n 1 <<<"$mail_stages" | cut -d ' ' -f 2)
    [ -n "$use_case" ] || use_case="Newses ($website_url) is a self-hosted RSS reader. It emails \
only its own users and the people they choose to send an article to: a link that confirms the \
address a user adds to their account, an article a user sends from the app with their own \
address as Reply-To, and an optional daily or weekly digest of the user's unread articles. Users \
turn the digest on themselves, and each digest has a one-click List-Unsubscribe header (RFC \
8058) and an unsubscribe link. Mail is sent from newses@$(cut -d / -f 3 <<<"$website_url"), a domain verified \
with DKIM and a custom MAIL FROM domain, through a configuration set whose suppression list \
stops mail to addresses that bounced or complained. Volume is low: a few messages per user per \
day."
  fi
fi
to_add=()
for address in ${recipients[@]+"${recipients[@]}"}; do
  if grep -qixF "$address" < <(cut -f 1 <<<"$verified"); then
    echo "$address is already a test recipient; not adding it again."
  else
    to_add+=("$address")
  fi
done

$request || [ "${#to_add[@]}" -gt 0 ] || exit 0
if ! $apply; then
  echo
  if $request; then
    echo "Would ask for production access for $website_url (transactional mail)" \
      "${contacts[*]+with answers also to ${contacts[*]}}"
    echo "Use case: $use_case"
  fi
  for address in ${to_add[@]+"${to_add[@]}"}; do echo "Would add the test recipient $address"; done
  echo
  echo 'Nothing changed: rerun with --apply to make these changes.'
  exit 0
fi

step=''
trap 'echo "ses-setup: failed while ${step:-starting}; rerunning is safe" >&2' ERR

if $request; then
  step='asking for production access'
  contact_args=()
  [ "${#contacts[@]}" -eq 0 ] || contact_args=(--additional-contact-email-addresses "${contacts[@]}")
  "${ses[@]}" put-account-details --production-access-enabled --mail-type TRANSACTIONAL \
    --website-url "$website_url" --contact-language EN --use-case-description "$use_case" \
    ${contact_args[@]+"${contact_args[@]}"}
  echo
  echo "Asked for production access for $website_url. AWS answers by email once it has reviewed"
  echo 'the request; rerun this script to see the review status.'
fi

for address in ${to_add[@]+"${to_add[@]}"}; do
  step="adding the test recipient $address"
  "${ses[@]}" create-email-identity --email-identity "$address" >/dev/null
  echo "SES mailed $address a confirmation link; the stages can email it once it is followed."
done
