#!/usr/bin/env bash
# Docker for the release pipeline's image legs and publish leg (release-image.yml,
# release-publish.yml): buildx, pinned and checked, and a login to ECR Public, which serves only
# from us-east-1. --builder also creates a BuildKit builder, as Docker's own cannot push by
# digest; --cosign installs cosign, pinned and checked, which signs the image.
set -euo pipefail

# Versions at least two weeks old when pinned. BuildKit's image is only on Docker Hub.
BUILDX_VERSION=v0.38.1
declare -A BUILDX_SHA256=(
  [amd64]=e25d5cd675092bb5d1d03632fdc46cdf3fede7b514dc5f023a105e00d3ce5ad4
  [arm64]=3b83b3731916ba433feccaaa689fe5bcdc81c641d92c8e6c2ea865dfa141c97a
)
BUILDKIT_IMAGE=moby/buildkit:v0.34.1@sha256:99368f3e46177c6405b9740e4461d91cee004128daeecca78d4ceac50ec1da5c
COSIGN_VERSION=v3.1.4
declare -A COSIGN_SHA256=(
  [amd64]=424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa
  [arm64]=ade83b7aac62e131cacfe96d958948b2150cc9efec46a570a2649b8e27dedad2
)

case "$(uname -m)" in
  x86_64) arch=amd64 ;;
  aarch64) arch=arm64 ;;
  *) echo "image-setup: no buildx for $(uname -m)" >&2; exit 1 ;;
esac
plugin=$HOME/.docker/cli-plugins/docker-buildx
mkdir -p "$(dirname "$plugin")"
curl -fsSL -o "$plugin" \
  "https://github.com/docker/buildx/releases/download/$BUILDX_VERSION/buildx-$BUILDX_VERSION.linux-$arch"
echo "${BUILDX_SHA256[$arch]}  $plugin" | sha256sum -c --quiet
chmod +x "$plugin"
docker buildx version

aws ecr-public get-login-password --region us-east-1 |
  docker login --username AWS --password-stdin public.ecr.aws

case "${1:-}" in
  --builder) docker buildx create --use --driver docker-container --driver-opt "image=$BUILDKIT_IMAGE" ;;
  --cosign)
    curl -fsSL -o /usr/local/bin/cosign \
      "https://github.com/sigstore/cosign/releases/download/$COSIGN_VERSION/cosign-linux-$arch"
    echo "${COSIGN_SHA256[$arch]}  /usr/local/bin/cosign" | sha256sum -c --quiet
    chmod +x /usr/local/bin/cosign
    cosign version
    ;;
esac
