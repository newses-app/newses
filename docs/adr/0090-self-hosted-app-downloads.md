# 0090. Self-hosted app downloads

- Status: Accepted
- Date: 2026-11-13

## Context
0052 publishes the apps per AWS stage at `/downloads/`, where their updaters look. Docker installs have no downloads, so their readers use the project's apps, which update from the project's stage rather than from the server they read. Building Windows apps needs Windows; the Android build tools are x86_64 only.

## Decision
- `docker/compose.apps.yaml` adds an `apps` service, under an `apps` profile, that builds the Linux desktop app (AppImage and deb) and the Android APK from a checkout of the release tag, on linux/amd64. It publishes them, with their SBOMs, feeds, `latest.json`, and page, to the install's `downloads` volume; an install from a release's files runs it from a checkout with its own `.env`.
- The server serves that volume at `/downloads/` (`DOWNLOADS_DIR`, set in `compose.yaml`), with the headers CloudFront gives them on AWS. The apps update from `PUBLIC_URL/downloads/`, which must be https.
- The APK is signed with the operator's own keystore, passed as Compose secrets from `.env`; without one only Linux builds (`APPS_PLATFORMS=linux`), as an unsigned APK cannot be installed.
- A release's platforms are optional in the manifest, page, and upload plan; AWS still builds all three.
- The build is an override rather than a profile in `compose.yaml`, as the published compose file runs from a folder with no checkout and builds nothing.

## Consequences
- Docker readers get apps that update from their own server.
- An APK signed with the operator's key cannot update over the project's, or the reverse: readers switching uninstall first, which deletes offline data.
- Windows and macOS apps are not built on Docker.
- Operators rebuild the apps after each upgrade, and keep their keystore and its password backed up.
