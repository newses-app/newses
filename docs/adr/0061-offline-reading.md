# 0061. Offline reading

- Status: Accepted
- Date: 2026-10-15
- Supersedes 0011, 0028

## Context
ADR 0011 made the clients online-first, and 0028 kept server state only in the query cache. Readers now want to keep reading, with images, on planes and patchy mobile connections in the web, desktop, and Android apps. The API is already sync-ready (0027). Its gaps:
- a first sync walks every entry the user has;
- sync misses edited content and full-text results, because they change only the shared `entries` row;
- the apps cannot read proxied images on AWS, because CloudFront forwards no `Origin` on that path.

The rest of 0028 stands.

## Decision
- **One local store.** The web app keeps an IndexedDB store per account, shared by all three clients. It is opt-in per device in browsers and on by default in the apps.
- **Network first.** Online behaviour is unchanged: server lists, server search, live counters. A background sync keeps the store fresh, and reads fall back to it when the server is unreachable. Opening an article uses the stored copy when its content version matches.
- **What is kept.** Unread and starred entries with their text and images, and headlines read in the last 7 days, within a storage limit. Images download through signed image-proxy URLs, whatever the user's `proxyImages`.
- **Sync API.**
  - `GET /sync/token` starts a sync from now; the store fills from headline lists.
  - A content or full-text change touches each subscriber's user entry, so sync carries it.
  - Entries carry `readAt` and `contentVersion`.
  - `POST /entries/contents` returns content and image URLs in batches.
  - API 1.1. Offline turns on only against 1.1 or later.
- **Queued edits.**
  - These work offline: article state, catch-up, notes, labels, tags, feed and label organisation, preferences, and themes.
  - They are replayed on reconnect with conflict detection: a newer server value wins, labels and tags merge as add/remove, and note conflicts ask the reader.
  - Filters, sharing, full-text extraction, archive, OPML, account, and admin actions stay online-only.
- **Search and background sync.** Offline search covers stored articles. Installed Chromium PWAs and the Android app sync in the background.

## Consequences
- Offline data is unencrypted on the device. A revoked session's data stays until the app next reaches the server.
- Data is only as fresh as the last sync. Background sync covers installed Chromium PWAs and Android; other clients sync while open.
- Safari deletes the store after 7 days without a visit unless the app is on the Home Screen, losing queued edits.
- Images of kept entries are fetched and cached by the server even for readers who do not proxy images.
- Bundled apps against an older server stay online-only.
