# 0051. P4 native app scope

- Status: Accepted
- Date: 2026-10-10

## Context
P4 promised Electron builds for Windows, macOS, and Linux and an Android build on a device. A macOS build needs an Apple Developer ID, notarisation, and a macOS build host, none of which the project has. Apps that never update leave users on old builds, and publishing through Google Play adds an account, a review process, and its own update channel for a handful of household users.

## Decision
- P4 ships Electron apps for Windows and Linux and a Capacitor app for Android.
- macOS moves to Later.
- Apps keep themselves current within P4: the desktop apps update in place, and the Android app prompts for a newer APK.
- Android is sideloaded from the project's own downloads, not Google Play.

## Consequences
- No Apple account or macOS build host is needed.
- P4 includes signing, a release pipeline, and downloads hosting so that updates can be trusted and found.
- Android users must allow installs from their browser once, and updates are confirmed by the user.
