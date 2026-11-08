# 0084. Sign the server image with cosign and a KMS key

- Status: Accepted
- Date: 2026-11-08

## Context
The release's compose file pins the server image by digest and comes from the HTTPS downloads page with `SHA256SUMS`, so installs from it are tied to the published image. People who pull by tag, or run the image without the compose file, have nothing to check it against. Keyless Sigstore signing needs an OIDC identity that public Fulcio accepts, which CodeBuild does not have; the release pipeline runs on CodeBuild.

## Decision
- The publish leg signs each version's multi-arch image with cosign and an asymmetric AWS KMS key (ECDSA P-256), right after pushing its version tag and before the downloads go up.
- One key serves the repository and both stages. `scripts/image-registry-setup.sh` creates it outside the stacks, as `alias/<prefix>-image-signing` in the deployment's region; only the release stacks' publish roles may sign with it.
- Signatures are recorded in Sigstore's public transparency log (Rekor) and stored in cosign's tag layout (`sha256-<digest>.sig`), which cosign 2 and 3 verify with `cosign verify --key cosign.pub <image>`.
- Each release publishes the public key beside its compose file, with the verify command on the downloads page.

## Consequences
The key costs about $1 a month. Verifying needs no AWS account. The pipeline deletes a superseded prerelease's signature with its tags. Losing or deleting the key means a new key and a new public key in later releases; earlier signatures still verify against the earlier releases' keys. cosign's tag layout is deprecated in favour of Sigstore bundles stored as OCI referrers, which ECR Public's support is unconfirmed for; moving to them changes only the publish leg.
