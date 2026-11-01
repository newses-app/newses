# 0082. Language selection and one-off translations

- Status: Accepted
- Date: 2026-11-01
- Supersedes 0081

## Context
All UI strings are externalised, but every package is fixed to `en`, and 0081 left choosing a language until a translation exists. Spanish is the first. The app has about 835 strings and one maintainer to review them. Feeds arrive in any language and direction, whatever the UI's language. Installed native apps hold their translations for as long as they stay installed, and can talk to older servers.

## Decision
- Kept from 0081: `/api/v1` errors carry an optional, append-only `reason` and its `params`; `error` and `message` do not change; each package that shows text has its own locale file; bare text in web templates fails the lint.
- A language is a `src/locales/<code>.json` in each package, listed in a registry in `shared` with its own name, direction, and plural forms. It joins the registry once reviewed.
- A nullable `language` user preference chooses the language, and `null` follows the device. It is a loose string, not an enum, so an older server does not refuse a newer app's language. Before preferences load, the web app uses a per-profile cache, then the device's languages, then `en`. A server without the preference leaves the choice on that device.
- Translations are files in the repository, drafted by AI and reviewed by the maintainer in the running app. There is no translation service, and nothing is fetched at runtime, so the privacy requirement and offline use hold.
- A changed meaning takes a new key. Missing keys fall back to `en` and never fail `pnpm check`, so translation cannot block a release; malformed translations do fail it.
- The public share page uses the viewer's `Accept-Language`, then the owner's preference, then `en`. The published feed and OPML export use the owner's preference.
- Feed errors gain a reason and params, stored beside the text.
- Article content carries its own language and direction, separate from the UI's.
- Right-to-left layout is supported and tested with a development-only pseudo-locale. No right-to-left language ships until someone can review it.
- Not translated: API `message`, the CLI, the compatibility APIs, operator alerts, search operators, the project site, and the downloads page, where readers rely on browser translation.

## Consequences
- A new language needs a file in three packages, a registry entry, and an entry in Android's `locales_config.xml`.
- Nothing detects new wording under an unchanged key, so the new-key rule rests on review.
- New strings show in English until the next translation pass; a missing-key report shows which.
- A translation service is reconsidered when outside translators appear or a third language is wanted. It would work from the same files.
- Search still needs exact word forms, in every language.
- Text stored in English remains for alert summaries, and errors reached only through a bug or a stale tab stay in English, by way of `message`.
