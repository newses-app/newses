#!/usr/bin/env bash
# Sets up Android release signing: generates the release keystore (or reuses an existing one),
# copies it to an offline backup folder and checks the copy, then writes the values to
# mobile/android-signing.env (local signed builds) and, with --ssm, to SSM.
# Losing the keystore or its password means installed apps can never be updated.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/android-signing-setup.sh --backup DIR [--keystore FILE] [--alias NAME]
                                        [--dname DN] [--ssm] [--dry-run]

  --backup DIR     Offline backup folder; the keystore is DIR/rss-reader-release.jks, generated
                   there if missing and reused if present
  --keystore FILE  Use this existing keystore instead (no backup copy is made)
  --alias NAME     Key alias (default: rss-reader)
  --dname DN       Certificate subject for a new keystore (default: CN=RSS Reader)
  --ssm            Also store the values as SecureString parameters under
                   /rss-reader/release/android-signing/ (AWS CLI credentials, us-east-2)
  --dry-run        Show what would happen, then stop before any change

The password comes from ANDROID_KEYSTORE_PASSWORD, else mobile/android-signing.env, else a
prompt; a new keystore gets a random one. Every step can be rerun.
EOF
}

die() {
  echo "android-signing-setup: $*" >&2
  exit 2
}

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
env_file="$root/mobile/android-signing.env"
ssm_path=/rss-reader/release/android-signing
region=us-east-2
name=rss-reader-release.jks
# Standard-tier SSM parameters hold up to 4 KB.
standard_max=4096

backup='' keystore='' alias=rss-reader dname='CN=RSS Reader' ssm=false dry_run=false
while [ $# -gt 0 ]; do
  case "$1" in
    --backup | --keystore | --alias | --dname)
      [ $# -ge 2 ] || die "$1 needs a value"
      case "$1" in
        --backup) backup=$2 ;;
        --keystore) keystore=$2 ;;
        --alias) alias=$2 ;;
        --dname) dname=$2 ;;
      esac
      shift 2
      ;;
    --ssm) ssm=true; shift ;;
    --dry-run) dry_run=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[ -n "$backup$keystore" ] || die 'pass --backup DIR (or --keystore FILE)'

command -v keytool >/dev/null || die 'needs keytool (JDK 21)'
command -v openssl >/dev/null || die 'needs openssl'
if $ssm; then
  command -v aws >/dev/null || die '--ssm needs the AWS CLI (aws)'
  aws sts get-caller-identity >/dev/null 2>&1 || die '--ssm needs AWS credentials'
fi

generate=false
if [ -z "$keystore" ]; then
  [ -d "$backup" ] || die "no backup folder $backup"
  keystore=$backup/$name
  [ -e "$keystore" ] || generate=true
fi
[ -e "$keystore" ] || $generate || die "no keystore $keystore"
keystore=$(realpath -m "$keystore")

step=''
trap 'echo "android-signing-setup: failed while ${step:-starting}; rerunning is safe" >&2' ERR
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# keytool reads the password from the environment, so it never appears in a process list.
export ANDROID_KEYSTORE_PASSWORD
if $generate; then
  echo "Keystore: $keystore (new)"
  if $dry_run; then
    echo "Dry run: would generate $keystore (alias $alias, $dname) and store its values."
    exit 0
  fi
  step='generating the keystore'
  ANDROID_KEYSTORE_PASSWORD=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 32)
  # PKCS12 keystores use the store password for the key too.
  keytool -genkeypair -keystore "$work/$name" -storetype PKCS12 -alias "$alias" \
    -keyalg RSA -keysize 2048 -validity 10000 -dname "$dname" \
    -storepass:env ANDROID_KEYSTORE_PASSWORD -noprompt >"$work/keytool.log" 2>&1 ||
    die "keytool could not create the keystore: $(cat "$work/keytool.log")"

  step="backing up the keystore to $backup"
  # An existing keystore is never replaced.
  (umask 077; cp --update=none "$work/$name" "$keystore")
  cmp -s "$work/$name" "$keystore" || die "the backup copy $keystore does not match"
  echo "Backed up the keystore to $keystore"
else
  echo "Keystore: $keystore (existing)"
  if [ -z "${ANDROID_KEYSTORE_PASSWORD:-}" ] && [ -f "$env_file" ]; then
    ANDROID_KEYSTORE_PASSWORD=$(sed -n 's/^ANDROID_KEYSTORE_PASSWORD=//p' "$env_file")
  fi
  if [ -z "${ANDROID_KEYSTORE_PASSWORD:-}" ]; then
    read -rsp 'Keystore password: ' ANDROID_KEYSTORE_PASSWORD
    echo
  fi
fi

step='reading the keystore'
fingerprint=$(keytool -list -v -keystore "$keystore" -alias "$alias" \
  -storepass:env ANDROID_KEYSTORE_PASSWORD 2>/dev/null | sed -n 's/^[[:space:]]*SHA256: //p') ||
  die "cannot open alias $alias in $keystore with that password"
[ -n "$fingerprint" ] || die "no certificate for alias $alias in $keystore"
echo "Alias: $alias"
echo "Certificate SHA-256: $fingerprint"

if $dry_run; then
  echo "Dry run: would write $env_file$($ssm && echo ' and the SSM parameters')."
  exit 0
fi

step="writing $env_file"
(
  umask 077
  printf '%s=%s\n' \
    ANDROID_KEYSTORE_FILE "$keystore" \
    ANDROID_KEYSTORE_PASSWORD "$ANDROID_KEYSTORE_PASSWORD" \
    ANDROID_KEY_ALIAS "$alias" \
    ANDROID_KEY_PASSWORD "$ANDROID_KEYSTORE_PASSWORD" >"$env_file"
)
echo "Wrote $env_file (gitignored)"

if $ssm; then
  step='storing the SSM parameters'
  # Values go through a private file so the password never appears in a process list.
  request=$work/request.json
  put() {
    printf '{"Name":"%s/%s","Type":"SecureString","Overwrite":true,"Tier":"%s","Value":"%s"}' \
      "$ssm_path" "$1" "$3" "$(sed 's/["\\]/\\&/g' <<<"$2")" >"$request"
    aws ssm put-parameter --region "$region" --cli-input-json "file://$request" >/dev/null
  }
  keystore_base64=$(base64 -w0 "$keystore")
  tier=Standard
  [ ${#keystore_base64} -le $standard_max ] || tier=Advanced
  put keystore "$keystore_base64" "$tier"
  put keystore-password "$ANDROID_KEYSTORE_PASSWORD" Standard
  put key-alias "$alias" Standard
  put key-password "$ANDROID_KEYSTORE_PASSWORD" Standard
  echo "Stored 4 SecureString parameters under $ssm_path (keystore: $tier tier)"
fi

if $generate; then
  cat <<EOF

Save this keystore password in your password manager with the backup at $keystore:
  $ANDROID_KEYSTORE_PASSWORD
EOF
fi
