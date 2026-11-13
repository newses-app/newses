#!/usr/bin/env bash
# compose.apps.yaml's apps service (apps.Dockerfile): builds this checkout's Linux and Android apps,
# as the release pipeline's Linux leg does, and publishes them with their SBOMs, feeds, latest.json,
# and page to DOWNLOADS_DIR, which the server serves at PUBLIC_URL/downloads/, where the apps update
# from. The APK is signed with the keystore in the service's secrets.
#   RELEASE_TAG     the tag checked out, e.g. v1.2.3 or v1.2.3-rc.1 (a prerelease)
#   PUBLIC_URL      the server's https address
#   APPS_PLATFORMS  linux, android, or both (the default)
set -euo pipefail

die() {
  echo "apps: $*" >&2
  exit 2
}

secrets=/run/secrets
downloads=${DOWNLOADS_DIR:-/data/downloads}
platforms=${APPS_PLATFORMS:-linux,android}
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

linux=false android=false
IFS=, read -ra wanted <<<"$platforms"
for platform in "${wanted[@]}"; do
  case "$platform" in
    linux) linux=true ;;
    android) android=true ;;
    windows) die 'Windows apps build on Windows only; set APPS_PLATFORMS to linux, android, or both' ;;
    *) die "APPS_PLATFORMS takes linux, android, or both, not $platform" ;;
  esac
done
$linux || $android || die 'APPS_PLATFORMS names no platform'

if $android; then
  for secret in android_keystore android_keystore_password android_key_alias android_key_password; do
    [ -s "$secrets/$secret" ] || die "the Android app is signed with your release keystore, and $secret is empty.
Set ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, and ANDROID_KEY_PASSWORD
in .env (scripts/android-signing-setup.sh --backup DIR --docker writes them), or build only the
Linux apps with APPS_PLATFORMS=linux."
  done
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

if $linux; then
  # electron-builder takes the version from package.json; this copy of the checkout is the image's.
  (cd desktop && npm pkg set version="$version")
  pnpm --filter @newses/desktop build:linux:release
  cp "desktop/release/newses-$version-linux-x86_64.AppImage" \
    "desktop/release/newses-$version-linux-amd64.deb" desktop/release/latest-linux.yml "$artifacts/"
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
