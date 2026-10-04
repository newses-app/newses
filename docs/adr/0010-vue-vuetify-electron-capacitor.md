# 0010. Vue/Vuetify web app with Electron and Capacitor shells

- Status: Accepted
- Date: 2026-10-03

## Context
The owner wants Vue and Vuetify for the UI, plus desktop and mobile apps, without maintaining separate codebases.

## Decision
- One Vue 3 + Vuetify 3 SPA (Vite, Pinia, Vue Router, TanStack Vue Query).
- Electron (desktop) and Capacitor (mobile) wrap the same build.
- The server URL is configurable in the shells.

## Consequences
- One UI codebase.
- The UI must be responsive and work with both cookie and bearer authentication.
- Native features stay limited to what the shells expose.
