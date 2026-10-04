# 0027. Native API: sync, search, and events

- Status: Accepted
- Date: 2026-10-04

## Context
The web app and future offline/native clients need headline lists, state changes, counters, search, and incremental sync. `updated_at` is set to the writing transaction's start time, so a naive `updated_at > cursor` sync misses rows committed after a later-starting transaction. On a million entries, Postgres' plan for "newest matches first" can walk the whole headline index when a query matches nothing.

## Decision
- One `GET /sync` endpoint returns changed categories, subscriptions, and entries plus tombstoned ids since a token, instead of `since` on each list endpoint. Each call covers changes before a watermark: the start of the oldest open transaction in the database (from `pg_stat_activity`, so the app must connect as one role). Tombstones come from statement-level delete triggers and are kept 30 days; older tokens get `410 resync_required`.
- Headlines use keyset cursors; the cursor carries the resolved adaptive view.
- Search checks how many entries match, counting from the GIN index up to 20,000. Selective queries are materialised before sorting; common ones walk the headline index. Relevance ranks the 1,000 most recent matches.
- SSE sends per-user invalidation events coalesced per second, a 25 s heartbeat, and `X-Accel-Buffering: no`; streams end after 30 minutes.
- User preferences are typed in `shared` with defaults, and stored per key. The interval and purge preferences sit between subscription overrides and server defaults.

## Consequences
- Clients may receive a row twice across sync calls and must upsert idempotently.
- A long-open transaction delays sync until it ends.
- Relevance results ignore older matches when a query matches more than 1,000 of a user's entries.
