#!/usr/bin/env bash
# compose.apps.yaml's apps service (apps.Dockerfile): builds this checkout's Linux, Windows, and
# Android apps, as the release pipeline's legs do, and publishes them with their SBOMs, feeds,
# latest.json, and page to DOWNLOADS_DIR, which the server serves at PUBLIC_URL/downloads/, where
# the apps update from. The APK is signed with the keystore in the service's secrets; the Windows
# apps with jsign, from a certificate file or Artifact Signing, or are left unsigned.
#   RELEASE_TAG     the tag checked out, e.g. v1.2.3 or v1.2.3-rc.1 (a prerelease)
#   PUBLIC_URL      the server's https address
#   APPS_PLATFORMS  linux, windows, android, comma-separated (default all three)
set -euo pipefail

die() {
  echo "apps: $*" >&2
  exit 2
}

secrets=/run/secrets
downloads=${DOWNLOADS_DIR:-/data/downloads}
platforms=${APPS_PLATFORMS:-linux,windows,android}
platforms=${platforms// /}

[ -n "${RELEASE_TAG:-}" ] || die 'set RELEASE_TAG in .env to the tag checked out, e.g. v1.2.3'
version=$(node -e "import('./shared/src/release.ts').then((m) => console.log(m.versionFromTag(process.argv[1]).name))" "$RELEASE_TAG") ||
  die "RELEASE_TAG is not a release tag: $RELEASE_TAG"
prerelease=()
[[ $version == *-* ]] && prerelease=(--prerelease)

case "${PUBLIC_URL:-}" in
  https://*) ;;
  *) die "set PUBLIC_URL in .env to the server's https address: the apps update from it, over https only" ;;
esac
downloads_url="${PUBLIC_URL%/}/downloads"

linux=false windows=false android=false
IFS=, read -ra wanted <<<"$platforms"
for platform in "${wanted[@]}"; do
  case "$platform" in
    linux) linux=true ;;
    windows) windows=true ;;
    android) android=true ;;
    *) die "APPS_PLATFORMS takes linux, windows, and android, comma-separated, not $platform" ;;
  esac
done
$linux || $windows || $android || die 'APPS_PLATFORMS names no platform'

if $android; then
  for secret in android_keystore android_keystore_password android_key_alias android_key_password; do
    [ -s "$secrets/$secret" ] || die "the Android app is signed with your release keystore, and $secret is empty.
Set ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, and ANDROID_KEY_PASSWORD
in .env (scripts/android-signing-setup.sh --backup DIR --docker writes them), or leave android out
of APPS_PLATFORMS."
  done
fi

# Windows signing: a certificate file (WIN_CERTIFICATE_BASE64) or Artifact Signing
# (AZURE_CLIENT_SECRET with the WIN_SIGNING_* values), else unsigned.
windows_signing=none
if $windows; then
  if [ -s "$secrets/windows_certificate" ] && [ -s "$secrets/azure_client_secret" ]; then
    die 'set WIN_CERTIFICATE_BASE64 or AZURE_CLIENT_SECRET in .env, not both'
  elif [ -s "$secrets/windows_certificate" ]; then
    windows_signing=certificate
    [ -s "$secrets/windows_certificate_password" ] || die 'set WIN_CERTIFICATE_PASSWORD in .env'
  elif [ -s "$secrets/azure_client_secret" ]; then
    windows_signing=artifact-signing
    for name in AZURE_TENANT_ID AZURE_CLIENT_ID WIN_SIGNING_ENDPOINT WIN_SIGNING_ACCOUNT_NAME \
      WIN_SIGNING_PROFILE_NAME; do
      [ -n "${!name:-}" ] || die "Artifact Signing needs $name in .env (scripts/windows-signing-setup.sh --docker writes them)"
    done
  fi
  if [ "$windows_signing" != none ] && [ -z "${WIN_PUBLISHER_NAME:-}" ]; then
    die "set WIN_PUBLISHER_NAME in .env to the signing certificate's CN: installed apps update only to builds that carry it"
  fi
fi
[ -w "$downloads" ] || die "$downloads is not writable"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
artifacts=$work/artifacts
mkdir -p "$artifacts"
export RELEASE_TAG DOWNLOADS_URL=$downloads_url
# The image installed the dependencies; setting desktop's version must not make pnpm reinstall.
export pnpm_config_verify_deps_before_run=false
echo "Building Newses $version for $platforms, updating from $downloads_url/"

# jsign's options, one per line (electron-builder.jsign.cjs); secrets stay in files it reads.
case $windows_signing in
  certificate)
    certificate=$work/windows.pfx
    (umask 077 && base64 -d <"$secrets/windows_certificate" >"$certificate") ||
      die 'WIN_CERTIFICATE_BASE64 is not base64'
    owner=$(keytool -list -v -storetype PKCS12 -keystore "$certificate" \
      -storepass:file "$secrets/windows_certificate_password" 2>&1 | sed -n 's/^Owner: //p' | head -1) ||
      true
    [ -n "$owner" ] || die 'cannot open the Windows certificate: WIN_CERTIFICATE_BASE64 must be a .pfx, and WIN_CERTIFICATE_PASSWORD its password'
    case ", $owner," in
      *", CN=$WIN_PUBLISHER_NAME,"* | *", CN=\"$WIN_PUBLISHER_NAME\","*) ;;
      *) die "WIN_PUBLISHER_NAME must be the certificate's CN, and its subject is $owner" ;;
    esac
    printf '%s\n' --storetype PKCS12 --keystore "$certificate" \
      --storepass "file:$secrets/windows_certificate_password" \
      --tsaurl http://timestamp.digicert.com --tsmode RFC3161 >"$work/jsign.options"
    ;;
  artifact-signing)
    credentials=$work/azure-credentials
    (umask 077 && printf '%s|%s|%s' "$AZURE_TENANT_ID" "$AZURE_CLIENT_ID" \
      "$(<"$secrets/azure_client_secret")" >"$credentials")
    endpoint=${WIN_SIGNING_ENDPOINT#https://}
    printf '%s\n' --storetype TRUSTEDSIGNING --keystore "${endpoint%%/*}" \
      --storepass "file:$credentials" \
      --alias "$WIN_SIGNING_ACCOUNT_NAME/$WIN_SIGNING_PROFILE_NAME" \
      --tsaurl http://timestamp.acs.microsoft.com --tsmode RFC3161 >"$work/jsign.options"
    ;;
esac
if [ "$windows_signing" != none ]; then
  export JSIGN_OPTIONS_FILE=$work/jsign.options
  echo "Signing the Windows apps for $WIN_PUBLISHER_NAME ($windows_signing)"
elif $windows; then
  echo 'The Windows apps are unsigned: Windows warns before running them, and the installer does not update itself.'
fi

desktop=()
$linux && desktop+=(--linux)
$windows && desktop+=(--win)
if [ ${#desktop[@]} -gt 0 ]; then
  # electron-builder takes the version from package.json; this copy of the checkout is the image's.
  (cd desktop && npm pkg set version="$version")
  pnpm --filter @newses/desktop build
  pnpm --filter @newses/desktop exec electron-builder "${desktop[@]}" --publish never \
    --config electron-builder.release.cjs
  if $linux; then
    cp "desktop/release/newses-$version-linux-x86_64.AppImage" \
      "desktop/release/newses-$version-linux-amd64.deb" desktop/release/latest-linux.yml "$artifacts/"
  fi
  if $windows; then
    cp "desktop/release/newses-$version-windows-setup.exe" \
      "desktop/release/newses-$version-windows-setup.exe.blockmap" desktop/release/latest.yml \
      "desktop/release/newses-$version-windows-x64.zip" \
      "desktop/release/newses-$version-windows-portable.exe" "$artifacts/"
  fi
  # The same packages on every platform.
  node infra/src/release/build-sbom.ts --deliverable desktop --tag "$RELEASE_TAG" --out "$artifacts"
fi

if $android; then
  keystore=$work/release.jks
  (umask 077 && base64 -d <"$secrets/android_keystore" >"$keystore") ||
    die 'ANDROID_KEYSTORE_BASE64 is not base64'
  chmod +x mobile/android/gradlew
  ANDROID_KEYSTORE_FILE=$keystore \
    ANDROID_KEYSTORE_PASSWORD=$(<"$secrets/android_keystore_password") \
    ANDROID_KEY_ALIAS=$(<"$secrets/android_key_alias") \
    ANDROID_KEY_PASSWORD=$(<"$secrets/android_key_password") \
    pnpm --filter @newses/mobile build:apk:release
  rm "$keystore"
  # Only a signed build has this name.
  cp "mobile/release/newses-$version-android.apk" "$artifacts/"
  node infra/src/release/build-sbom.ts --deliverable mobile --tag "$RELEASE_TAG" --out "$artifacts"
fi

node infra/src/release/build-openapi.ts --tag "$RELEASE_TAG" --out "$artifacts"
node infra/src/release/publish.ts --dir "$artifacts" --tag "$RELEASE_TAG" --url "$downloads_url" \
  --platforms "$platforms" "${prerelease[@]}" >/dev/null
node infra/src/release/publish-local.ts --dir "$artifacts" --to "$downloads"
echo "The apps are at $downloads_url/"
