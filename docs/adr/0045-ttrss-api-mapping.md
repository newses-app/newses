# 0045. TTRSS API mapping

- Status: Accepted
- Date: 2026-10-07

## Context
The TTRSS-compatible API (0012) maps TTRSS's feeds, categories, and articles onto subscriptions, nested categories, and user entries. Some of TTRSS's behaviour has no counterpart here, and its clients fetch feed icons by URL without sending credentials, while icons are otherwise served only to subscribers.

## Decision
- Feed icons are served at `/feed-icons/<user segment>/<subscription id>.ico`. The segment is the user id signed with a key derived from `APP_SECRET`; `getConfig` gives it to the user's clients as `icons_url`. Only the user's own subscriptions' icons are served.
- Category streams always include subcategories, as in the web app; `include_nested` only adds child categories to `getFeeds`.
- `shareToPublished` is not implemented: it creates an article that belongs to no feed, which the data model does not hold. Clients get `UNKNOWN_METHOD`.
- The Archived feed (0) is empty until archived feeds exist.
- Clients page headlines by offset (`skip`); the entry list accepts an offset beside its keyset cursor.

## Consequences
- Anyone holding a user's icon URL can fetch that user's feed icons, nothing else; changing `APP_SECRET` changes the URLs.
- Sharing arbitrary pages to the published feed from a TTRSS client does not work.
- Offset paging rescans skipped rows; client pages are small, so this stays cheap.
