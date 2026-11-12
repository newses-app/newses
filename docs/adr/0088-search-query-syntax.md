# 0088. Search query syntax

- Status: Accepted
- Date: 2026-11-11

## Context
Readers moving from TTRSS search with its operators (`title:`, `star:true`, `@2024-05-01`, `-`), and TTRSS clients send them in `getHeadlines`. Newses passed the whole query to `websearch_to_tsquery`, so operators were searched as words. Search runs in four places: headline lists, the archive (database and cold storage), offline search, and the compatibility API.

## Decision
- One parser in `shared` (`parseSearchQuery`, without Zod) reads `q` for every place: operators become filters on the stream, the rest stays free text in `websearch_to_tsquery`'s syntax. Unknown operators and values are free text, so earlier searches keep their meaning.
- Operators follow TTRSS: `title:`, `author:`, `note:` (text, or `true`/`false`), `tag:`, `label:`, `unread:`, `star:`, `pub:`, `@date` (a day, `today`, `yesterday`, `-Ndays`, `-Nweeks`), each negated by `-`. Keywords stay English in every language.
- Dates are days of `sort_at` in the reader's time zone, which `GET /entries` and `GET /archive/entries` take as `timeZone`; UTC without it. API 1.13.
- Past articles have no state: state operators match none of them, and their negations every one.

## Consequences
- The server, the archive, and the device read a search the same way; offline search applies the filters to stored entries.
- Searches of operators alone list newest first, as there is nothing to rank.
- TTRSS clients get UTC days, as Newses keeps no time zone per user.
- Cold-storage search matches an article's last copy, and treats `OR` as `AND`.
