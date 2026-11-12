# 0089. Language-aware search

- Status: Accepted
- Date: 2026-11-11

## Context
Search used the `simple` configuration (0020): `articulo` missed "artículo", and `song` missed "songs". 0020 left per-language stemming to a new ADR. Feeds are multilingual, entries carry their feed's language (`lang`), and offline search must find what the server finds.

## Decision
- The `unaccent` extension and text search configurations `newses_simple` (`unaccent`, then `simple`) and `newses_<language>` (`unaccent`, then the Snowball stemmer) for the languages PostgreSQL and the web app both stem (`SEARCH_LANGUAGES` in `shared`).
- `entries.search` holds each entry's words folded, and again stemmed in its language when it has a stemmer. Notes are folded only.
- A query matches each word or phrase folded, or stemmed in one of the reader's languages: their feeds' (each subscription's newest entry) and their app's.
- Offline search stems at query time with `@orama/stemmers`, loaded per language, in the languages of the stored entries and the device: a word matches the stored words that share its stem, so the stored index stays as it is.
- Cold storage folds accents, and does not stem.

## Consequences
- The migration rewrites `entries` and rebuilds its search index; the search column grows by about the size of the stemmed copy.
- Self-hosted PostgreSQL needs `unaccent` (a contrib module, trusted since PostgreSQL 13).
- Orama's stemmers are not PostgreSQL's in every detail, so offline and online matches can differ at the edges.
- Scripts without spaces (CJK) are not segmented on the server; that is a further step.
