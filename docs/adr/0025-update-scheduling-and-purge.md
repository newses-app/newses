# 0025. Feed update scheduling and purge

- Status: Accepted
- Date: 2026-10-04

## Context
Feeds are fetched by background workers, possibly more than one. Failing feeds must back off without hammering servers. Purging old entries must not let them reappear as new on the next fetch, which is a known TTRSS annoyance.

## Decision
- Scheduling state lives in `feed_sources.next_fetch_at`. A minute-by-minute dispatcher claims due rows with `FOR UPDATE SKIP LOCKED` and a 15-minute lease, then enqueues deduplicated `feed.fetch` jobs. The queue does not retry fetch jobs; the updater owns backoff.
- Backoff is exponential from the feed interval, capped at a day, respecting `Retry-After`. HTTP 410 or N consecutive failures disables the feed until a manual refresh.
- `entries.last_seen_at` records the last fetch whose document contained an entry. Purge deletes unreferenced entries only after 7 days absent from the feed.
- Fan-out skips entries older than the subscriber's purge age, so old feed archives are not delivered.

## Consequences
- Multiple workers are safe.
- Disabled feeds stay visible with their last error.
- Entry rows of long-lived feeds persist while the feed still lists them, even after users' copies are purged.
- Purge exempts only starred and published entries until notes and labels exist (P2).
