#!/usr/bin/env bash
# Generates the CycloneDX SBOMs of what we ship (infra/src/release/build-sbom.ts), validates them
# against the schema, and with --upload sends them to Dependency-Track
# (infra/src/release/upload-sbom.ts). --from uploads a published release's SBOMs instead.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/sbom.sh [--tag TAG] [--only LIST] [--out DIR] [--upload]
       scripts/sbom.sh --from URL [--out DIR]

  --tag TAG   Version from a release tag (v1.2.3, v1.2.3-rc.1); default: an untagged build,
              0.0.0-dev, uploaded under the current branch's name
  --only LIST Comma-separated deliverables (default: server,image,web,desktop,mobile)
  --out DIR   Where to write them (default: sbom/); earlier SBOMs there are deleted
  --upload    Upload them to Dependency-Track: DTRACK_URL (default http://localhost:8080) and
              DTRACK_API_KEY, from the environment or dtrack.env at the repository root
  --from URL  Upload a published release's SBOMs (desktop and mobile) instead of generating
              them, e.g. https://reader.example.com/downloads/1.2.3/

Needs Docker for the image SBOM and validation; mobile needs JDK 21 and the Android SDK.
EOF
}

die() {
  echo "sbom: $*" >&2
  exit 2
}

# Versions at least two weeks old when pinned.
SYFT=anchore/syft:v1.52.0
CYCLONEDX_CLI=cyclonedx/cyclonedx-cli:0.33.1

tag='' only=server,image,web,desktop,mobile out=sbom upload=false from=''
while [ $# -gt 0 ]; do
  case "$1" in
    --tag | --only | --out | --from)
      [ $# -ge 2 ] || die "$1 needs a value"
      case "$1" in
        --tag) tag=$2 ;;
        --only) only=$2 ;;
        --out) out=$2 ;;
        --from) from=$2 ;;
      esac
      shift 2
      ;;
    --upload) upload=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

[ -z "$from" ] || [ -z "$tag" ] || die '--from takes the version from the URL, not --tag'
IFS=, read -ra deliverables <<<"$only"
for deliverable in "${deliverables[@]}"; do
  case "$deliverable" in server | image | web | desktop | mobile) ;; *) die "unknown deliverable: $deliverable" ;; esac
done
[ -n "$from" ] || command -v docker >/dev/null || die 'needs Docker (validation and the image SBOM)'

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
mkdir -p "$out"
out=$(cd "$out" && pwd)
rm -f "$out"/*.cdx.json

if [ -n "$from" ]; then
  from=${from%/}/
  version=$(basename "$from")
  [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-.+)?$ ]] || die "no version at the end of $from"
  for deliverable in desktop mobile; do
    name="rss-reader-$version-$deliverable.cdx.json"
    curl -fsS --max-time 60 -o "$out/$name" "$from$name" || die "cannot download $from$name"
  done
  node infra/src/release/upload-sbom.ts --dir "$out" --tag "v$version"
  exit
fi

version=0.0.0-dev
[ -z "$tag" ] || version=${tag#v}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
build=(node infra/src/release/build-sbom.ts --out "$out" ${tag:+--tag "$tag"})
for deliverable in "${deliverables[@]}"; do
  echo "== $deliverable"
  case "$deliverable" in
    image)
      docker build -q -f docker/Dockerfile --build-arg "RSS_READER_VERSION=$version" \
        -t rss-reader:sbom . >/dev/null
      # Packages only: without the selection, syft also lists every file the packages own.
      docker run --rm -e SYFT_FILE_METADATA_SELECTION=none \
        -v /var/run/docker.sock:/var/run/docker.sock "$SYFT" -q docker:rss-reader:sbom -o cyclonedx-json@1.6 >"$work/image.json"
      "${build[@]}" --deliverable image --input "$work/image.json"
      ;;
    mobile)
      [ -n "${ANDROID_HOME:-}" ] || die 'mobile needs the Android SDK (ANDROID_HOME) and JDK 21'
      "${build[@]}" --deliverable mobile
      ;;
    *) "${build[@]}" --deliverable "$deliverable" ;;
  esac
done

for file in "$out"/*.cdx.json; do
  docker run --rm -v "$out:/sbom:ro" "$CYCLONEDX_CLI" validate --input-format json \
    --input-version v1_6 --fail-on-errors --input-file "/sbom/$(basename "$file")" >/dev/null ||
    die "$(basename "$file") is not valid CycloneDX 1.6"
done
echo "Validated $(find "$out" -name '*.cdx.json' | wc -l) SBOMs in $out"

if [ "$upload" = true ]; then
  if [ -n "$tag" ]; then
    node infra/src/release/upload-sbom.ts --dir "$out" --tag "$tag"
  else
    branch=$(git rev-parse --abbrev-ref HEAD)
    [ "$branch" != HEAD ] || die 'detached HEAD: upload with --tag'
    node infra/src/release/upload-sbom.ts --dir "$out" --branch "$branch"
  fi
fi
