# 0060. Token-based themes with custom and shared themes

- Status: Accepted
- Date: 2026-10-14

## Context
The web app had one fixed light and dark palette in the Vuetify plugin. Readers want to adjust colours, fonts, and density, keep named themes, pass them to others on the server, and pick distinctive built-in looks (Terminal, Sketch) that need their own fonts. Free-text CSS or font-family values would undermine the CSP and the Privacy requirement.

## Decision
- A theme is a set of tokens validated by Zod in `shared`: a style, light and dark palettes of `#rrggbb` colours, font keys (never font-family text), UI text scale, corners, density, borders, shadows, and effects. Built-in themes are code in `shared`.
- A custom theme stores a built-in base and partial overrides in a per-user `themes` table, with a `shared` flag that publishes it to every user of the server. It resolves as base plus overrides, so tokens added later take the base's defaults without data migrations.
- Preferences hold the theme reference (a built-in key or a theme id) and the reader's partial adjustments; the existing `theme` preference remains the light/dark/system mode.
- API: `GET/POST /themes`, `PATCH/DELETE /themes/:id` for the owner, and `POST /admin/themes/:id/unpublish` for admins.
- Theme fonts are bundled with the app and served from its own origin; no font is loaded from a third party.

## Consequences
- Themes apply client-side by overwriting Vuetify's light and dark themes, so mode switching and `system` keep working.
- A shared theme is a live reference; a deleted or unpublished theme falls back to Original.
- The app bundle grows by the bundled fonts, which download only when a theme uses them.
