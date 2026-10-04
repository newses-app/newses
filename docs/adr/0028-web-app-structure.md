# 0028. Web app structure and serving

- Status: Accepted
- Date: 2026-10-04

## Context
The P1 web app needs fast headline reading, TTRSS-style keyboard use, live counters, and a phone layout. It must run from the Docker image without a separate web server, and later from S3/CloudFront.

## Decision
- Vue 3 with Vuetify 4, vue-router 5, Pinia 4, TanStack Vue Query 5, vue-i18n; built by Vite as a PWA whose service worker caches only the app shell.
- Server state lives only in the query cache, with optimistic patches of every cached copy. Pinia holds UI state only.
- The open stream, entry, and search are in the URL, so views can be linked and reloaded.
- The API server serves the build from `WEB_DIR` with a strict CSP and SPA fallback. AWS will serve the same build from S3.
- `shared` gains a Zod-free `./client` entry so browser bundles do not carry the schemas.
- Playwright tests run against a deployed stack, outside `pnpm check`.

## Consequences
- One origin in Docker: cookies, CSRF, and SSE need no CORS.
- Inline styles are allowed by the CSP because Vuetify injects its theme at runtime.
- End-to-end coverage depends on running the stack; the AWS pipeline will need a stage for it.
