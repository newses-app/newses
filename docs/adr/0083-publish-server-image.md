# 0083. Publish the server image to ECR Public

- Status: Accepted
- Date: 2026-11-06

## Context
Self-hosters clone the repository and build the server image themselves, which takes minutes, about 1–2 GB of memory, and a slow emulated build on ARM hosts. What they run is whatever commit they built. The release pipeline already builds, signs, and publishes the apps from a version tag, on AWS CodeBuild with secrets in SSM. GitHub Container Registry would need a person-tied token in CodeBuild, or GitHub Actions as a second CI system; Docker Hub needs a token and limits anonymous pulls.

## Decision
- On each version tag, the stage's release pipeline builds the server image for `linux/amd64` and `linux/arm64` and publishes it to an ECR Public repository, pushing with the build projects' IAM roles.
- The repository is created outside the stacks by `scripts/image-registry-setup.sh` and named per stage in the deployment config (`imageRepository`); stages may share one, and a stage without it publishes no image.
- Releases are tagged `X.Y.Z`, plus `X.Y`, `X`, and `latest` when newest; prereleases `X.Y.Z-rc.N` and `next`. Version tags never move: a fixed base image ships as a new patch release.
- Self-hosters install from a compose file pinned to the image's digest and the sample configuration, published with each release on the downloads page; building from a checkout stays the contributor path.

## Consequences
No credential is stored for publishing. Anonymous pulls are free up to ECR Public's monthly allowance, after which heavy pullers sign in to AWS. ECR Public has no lifecycle rules, so the release pipeline deletes superseded prerelease tags itself. A custom registry alias is claimed once in the ECR Public console.
