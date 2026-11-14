# 0091. Self-hosted Windows apps

- Status: Accepted
- Date: 2026-11-14
- Supersedes 0090

## Context
0090 builds the Linux and Android apps on Docker and leaves Windows out, as the release pipeline builds it on Windows. electron-builder also builds the NSIS installer, zip, and portable exe on Linux, running NSIS's 32-bit installer under Wine to write the uninstaller. Its Artifact Signing support runs on Windows only. Unsigned NSIS installs do not update themselves (0052).

## Decision
- 0090 stands, with Windows added: the `apps` service builds the Windows installer, zip, and portable exe beside the Linux apps and the APK, publishing `latest.yml` and the block map. `APPS_PLATFORMS` defaults to all three.
- The apps image adds 32-bit Wine and jsign, both installed and checked at build time.
- Signing is optional and the operator's: a `.pfx` or Artifact Signing, through jsign in an electron-builder sign hook. The secrets are Compose secrets from `.env`, read by jsign from files. `WIN_PUBLISHER_NAME` is required to sign and checked against a `.pfx`'s CN.
- Without signing values, the Windows apps are built unsigned.

## Consequences
- Docker readers on Windows get apps from their own server; signed installs update themselves, unsigned ones warn on running and update through the downloads page.
- The apps image grows by about 850 MB.
- The installer is built under Wine without Windows-side checks; it must be tried on Windows.
- `.env` must hold every signing secret's line, even empty.
- macOS apps are not built on Docker.
