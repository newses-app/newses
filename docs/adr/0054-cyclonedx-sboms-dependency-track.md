# 0054. CycloneDX SBOMs and Dependency-Track

- Status: Accepted
- Date: 2026-10-12

## Context
Nothing records what each deliverable ships, so a new vulnerability in a dependency goes unnoticed until `pnpm audit` happens to run, and never for the Android app's Gradle dependencies or the Docker image's OS packages. The Dependency-Track server is self-hosted on a workstation, not reachable from AWS, and nothing may run all the time on AWS.

## Decision
- A CycloneDX 1.6 SBOM per deliverable (server, Docker image, web, desktop, mobile), from tools already in the build: `pnpm sbom` for npm packages, the CycloneDX Gradle plugin for the Android app, and syft (a pinned container) for the Docker image. One composer merges and stamps them with the release version.
- Bundled deliverables list what they ship, not what builds them: desktop keeps Electron and `electron-updater` of its devDependencies; workspace packages and Gradle projects are left out as first party.
- The release pipeline publishes the desktop and mobile SBOMs with each release under `/downloads/<version>/`, each naming the installers it describes by URL and SHA-256, beside a `SHA256SUMS`. Signing waits until the repository is public.
- Dependency-Track is external; uploads run locally (`scripts/sbom.sh --upload`, or `--from` a published release), to a configurable server.

## Consequences
- Dependency-Track sees a release only when someone uploads it; pipeline uploads need the server reachable from AWS.
- The server and web SBOMs and the Docker image SBOM are made locally only.
- Lockfile-based SBOMs over-report packages that bundles leave out (build-time dependencies of runtime packages), so some findings do not apply.
