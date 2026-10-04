# 0007. Shared feed sources with per-user state

- Status: Accepted
- Date: 2026-10-03

## Context
The instance serves a family who often subscribe to the same feeds. TTRSS separates shared entries (`ttrss_entries`) from per-user state (`ttrss_user_entries`), but keeps feeds per user.

## Decision
- `feed_sources` and `entries` are shared and fetched once per URL.
- `subscriptions` and `user_entries` hold per-user settings and state.
- Filters run per subscriber after the shared ingest.

## Consequences
- Fewer fetches and less storage.
- TTRSS data maps directly.
- Per-user fetch settings (interval, HTTP auth) must be reconciled per source: the shortest interval wins, and authenticated subscriptions get their own source.
