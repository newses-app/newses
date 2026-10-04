# 0020. Database schema conventions

- Status: Accepted
- Date: 2026-10-04

## Context
Schema v1 needed rules for keys, change tracking, headline query performance, and search before tables multiply. The TTRSS and Google Reader APIs expose numeric IDs.

## Decision
- Primary keys are identity integers (`bigint` for entries, enclosures, user entries, sessions, tombstones). No UUID keys; share links get a separate UUID column.
- `updated_at` is set by a `set_updated_at` trigger, so every write path bumps it.
- `user_entries.sort_at` denormalises the entry's published time (fetch time when absent). Partial indexes on (user, sort_at, id) serve unread/starred/published views.
- Full-text search uses a generated `tsvector` with the `simple` configuration: markup stripped, title weighted above content, no stemming (feeds are multilingual).
- Drizzle 0.45 stable; migrations are generated SQL, plus hand-written SQL for triggers.

## Consequences
- Compatibility APIs can use IDs directly.
- One extra column per user entry, kept in sync when an entry's published time changes.
- Search needs exact word forms; per-language stemming would need a new ADR.
- Moving to Drizzle 1.0 later changes the migration folder format.
