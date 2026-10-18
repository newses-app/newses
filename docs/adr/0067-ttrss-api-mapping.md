# 0067. TTRSS API mapping

- Status: Accepted
- Date: 2026-10-18
- Supersedes 0045

## Context
The TTRSS-compatible API (0012) maps TTRSS's feeds, categories, and articles onto subscriptions, nested categories, and user entries. Some of TTRSS's behaviour has no counterpart here, and its clients fetch feed icons by URL without sending credentials, while icons are otherwise served only to subscribers. Pages from outside any feed now have a home (0065) and can be published (0066).

## Decision
- Feed icons are served at `/feed-icons/<user segment>/<subscription id>.ico`. The segment is the user id signed with a key derived from `APP_SECRET`; `getConfig` gives it to the user's clients as `icons_url`. Only the user's own subscriptions' icons are served.
- Category streams always include subcategories, as in the web app; `include_nested` only adds child categories to `getFeeds`.
- `shareToPublished` publishes the page as the native API does (0066). Tags are stripped from the title and content, as TTRSS does, and values past the limits are cut rather than refused.
- The Archived feed (0) is empty until archived feeds exist.
- Clients page headlines by offset (`skip`); the entry list accepts an offset beside its keyset cursor.

## Consequences
- Anyone holding a user's icon URL can fetch that user's feed icons, nothing else; changing `APP_SECRET` changes the URLs.
- TTRSS clients' "share to published" works; HTML in shared content arrives as plain text.
- Offset paging rescans skipped rows; client pages are small, so this stays cheap.
