# 0080. Sync cursor from transaction ids

- Status: Accepted
- Date: 2026-10-26
- Supersedes 0027

## Context
Native sync windowed changes by `updated_at`, the writing transaction's start time, which is only correct while the database clock never goes back. Clocks do step back: a WSL2 host measured 2.85 s every 32 s, and Docker Desktop hosts resync after sleep. A change written after a step can get a time below a token a client already holds, and is never sent. The rest of 0027 (search, events, preferences) stands.

## Decision
- One `GET /sync` endpoint returns changed categories, subscriptions, labels, and entries plus tombstoned ids since a token. Synced rows carry `sync_xid`, the id of the transaction that last wrote them (a column default and a row trigger). Each call covers changes below a watermark: the oldest transaction id still in progress in this database, else the snapshot's `xmax` (`sync_watermark()`, reading `pg_stat_activity`, so the app must connect as one role). A full sync takes every row, then continues from the watermark it started at.
- Tokens carry the instance's sync epoch, kept in `ops_state` and made afresh when a restore leaves it out; tokens of another epoch, older than the 30-day tombstone retention, or unreadable get `410 resync_required`. Timestamp tokens from before `sync_xid` follow the rows written before it by `updated_at`, then the rest.
- Headlines use keyset cursors; the cursor carries the resolved adaptive view.
- Search checks how many entries match, counting from the GIN index up to 20,000. Selective queries are materialised before sorting; common ones walk the headline index. Relevance ranks the 1,000 most recent matches.
- SSE sends per-user invalidation events coalesced per second, a 25 s heartbeat, and `X-Accel-Buffering: no`; streams end after 30 minutes.
- User preferences are typed in `shared` with defaults, and stored per key. The interval and purge preferences sit between subscription overrides and server defaults.

## Consequences
- Sync no longer depends on the clock; only write transactions in the same database hold it back.
- Clients may receive a row twice across sync calls and must upsert idempotently.
- After a bundle restore, apps sync from scratch.
- Relevance results ignore older matches when a query matches more than 1,000 of a user's entries.
