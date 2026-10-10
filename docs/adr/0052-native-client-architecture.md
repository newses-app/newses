# 0052. Native client architecture and distribution

- Status: Accepted
- Date: 2026-10-10

## Context
0010 has the desktop and mobile shells wrap the web app with a configurable server URL. The shells load the app from a local origin, so the server is cross-origin, cookies are unusable, and the browser's same-origin assumptions in the web app break. Builds must be signed, released per stage, and found by the apps' updaters without waking the AWS database.

## Decision
- The shells bundle a native build of `web` (no service worker) that talks to a server URL chosen at first run. Only HTTPS servers are accepted.
- Apps sign in for bearer session tokens, kept in OS secure storage. The shells reach native features through a small platform bridge, which is a no-op in the browser.
- The server allows CORS on `/api/v1` from the app origins only, without credentials. `GET /api/v1/server` identifies the server and its API version to the connect screen.
- A tag-triggered release pipeline per stage builds, signs, and publishes the apps to `/downloads/` on that stage's domain, where the updaters check for new versions.
- Signing material is kept in SSM SecureString parameters (0033).

## Consequences
- One UI codebase serves the web and the apps; native-only paths stay behind the bridge.
- Cookie sessions remain same-origin; a page on another origin cannot ride on them.
- Update checks hit CloudFront and S3 only.
- Self-hosted servers must use HTTPS and forward `Authorization`, `Origin`, and `OPTIONS` to the server.
