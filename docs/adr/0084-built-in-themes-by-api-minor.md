# 0084. Built-in themes added by API minor, adapted to WCAG AA

- Status: Accepted
- Date: 2026-11-08

## Context
More built-in themes and styles are coming (Catppuccin, Solarized, Amber monitor, E-ink, Synthwave). Their keys and styles are values of the shared enums, so a server older than the app refuses them in `PATCH /prefs` and `POST /themes`, and the desktop and mobile apps still connect to older servers. Apps also meet servers newer than themselves, whose themes may name a built-in base the app doesn't have. Some published palettes (Catppuccin Latte, Solarized) fall below WCAG AA, which built-in themes meet.

## Decision
- Each built-in theme and each style records the API minor it arrived in; adding one takes the next API minor.
- Against an older server, the app offers neither, and refuses to import a theme that uses one, saying the server needs updating.
- An app shows Original in place of a built-in it doesn't have, as the server already does for stored values it no longer accepts.
- A built-in adapted from a published palette keeps its backgrounds and hues, and shifts text and accents to the nearest shade that passes AA.

## Consequences
- Apps from before API 1.8 index built-ins directly, so their Appearance settings fail on a custom theme based on a built-in they don't have.
- Built-ins inspired by a published palette are recognisable, not hex-exact; readers wanting the exact colours make a custom theme, which warns below AA.
