# Translations

## Adding a language

| Part | File |
|---|---|
| Messages | `src/locales/<code>.json` in `web`, `server`, and `desktop`, with the keys of `en.json` |
| Server and desktop imports | `MESSAGES` in `server/src/i18n.ts` and `desktop/src/i18n.ts` |
| Vuetify's text | `web/src/locales/vuetify/<code>.ts`: `export { es as default } from 'vuetify/locale';` |
| Registry | `LOCALES` in `shared/src/locales.ts`: code, the language's own name, direction, plural forms |
| Android per-app languages | `mobile/android/app/src/main/res/xml/locales_config.xml` |

- A language joins the registry once reviewed; the files and the registry land together.
- Plural forms are the CLDR categories its messages have, in the order they are written, ending in `other`. Categories left out use `other`: Spanish lists `one, other`, so CLDR's `many` for a million uses `other`.
- `pnpm check` holds the files to the registry and refuses malformed messages.

## Translation pass

1. `pnpm locales:status` lists the messages each language has yet to translate, by package. Missing messages show in English, and never fail `pnpm check`.
2. Draft them against the glossary.
3. Review in the running app, including narrow layouts, as translated text often runs longer.

## Messages

- A changed meaning takes a new key: nothing else flags a translation gone stale.
- Placeholders keep their names, and each message has the placeholders of its English.
- Plural forms are separated by ` | `.
- Zero is a separate key, and each message counts one thing: join separate counts in code.
- `{duration}` is a noun phrase from `time.*`, so a sentence around it needs no agreement with it.
- In `web`, write a literal `@`, `|`, or `{` as `{'@'}`.
- Not translated: the name Newses, search operators, the parser's explanation in `{detail}`, API `message`, the CLI, the compatibility APIs, operator alerts, the project site, and the downloads page.

## Pseudo-locales

Development builds offer two generated languages in Settings. Neither is in production builds.

| Code | Shows |
|---|---|
| `en-XA` | Text that isn't from a locale file, as everything else is accented and bracketed; tight layouts, as it runs longer |
| `ar-XB` | Right-to-left layout |

## Spanish

- Neutral across regions: `tú`, and words every region reads (`equipo`, `escribe`, `presiona`).
- Readers are addressed without gender: `tienes una suscripción`, not `estás suscrito`.
- `archivo` is both the archive and a file; context separates them.
- `time.*` uses figures (`1 hora`), as it follows `cada`.

## Glossary

| English | Means | Spanish |
|---|---|---|
| article | One entry of a feed | artículo |
| feed | A source a reader subscribes to | fuente |
| subscription | A reader's link to a feed | suscripción |
| category | A folder of feeds | categoría |
| label | A coloured marker a reader applies to articles | etiqueta |
| tag | A free-text word on an article | palabra clave |
| starred | Kept by the reader | destacado |
| published | In the reader's public feed | publicado |
| fresh | Unread and recent | reciente |
| archive | Past articles of a feed, read-only | archivo |
| typeface | The font setting; `fuente` is taken by feed | tipo de letra |
| settings | The app's settings | ajustes |
| sign in, sign out | Starting and ending a session | iniciar sesión, cerrar sesión |
| check | Fetching a feed for new articles | comprobar |
| shortcut | A keyboard binding | atajo |
| sync | Exchanging changes with the server | sincronizar |
