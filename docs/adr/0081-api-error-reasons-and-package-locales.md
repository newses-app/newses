# 0081. API error reasons and per-package locale files

- Status: Accepted
- Date: 2026-10-31

## Context
All UI strings must be externalised, but the web app showed server messages verbatim. `/api/v1` errors carried a code too coarse to translate: `invalid_input` alone covered about 40 situations. Desktop menus and public pages were hard-coded in English, and neither can import from `web`. Installed native apps can talk to older servers and hold old translations for as long as they stay installed.

## Decision
- `/api/v1` errors gain an optional `reason`, one of `ERROR_REASONS` in `shared`, and `params` with its values. `error` and `message` do not change. This is not a new API version: clients that ignore `reason` are unaffected, and `reason` is never required.
- Reasons are append-only. A reason whose params change becomes a new reason, because older apps hold the old message.
- Only failures the web app shows, whose code does not say enough, get a reason. One generic message serves every `not_found`, and one every over-long value.
- The web app shows the reason's text, else the code's text, else `message`. Codes with text are those that say the same whatever was refused; the others fall through, so an older server's `message` still reaches the reader.
- Each package that shows text has its own `src/locales/en.json`: `web` (with vue-i18n), `desktop`, and `server`.
- `vue/no-bare-strings-in-template` fails the lint for bare text in web templates, and a test holds the locale file to `ERROR_REASONS`.
- The locale stays `en`; choosing a language is left until a translation exists.

## Consequences
- English error text exists twice, on the server for the compatibility APIs, CLI, and older apps, and in the web locale file.
- A new language needs a file in each of the three packages.
- Text stored in English (a feed's last error, alert summaries) is not translated.
- Errors reached only through a bug or a stale tab stay in English, by way of `message`.
