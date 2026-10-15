# 0011. Online-first clients with a sync-ready API

- Status: Superseded by 0061
- Date: 2026-10-03

## Context
Offline reading in the apps would add a local store and conflict handling early on.

## Decision
- Clients are online-first.
- The API supports incremental sync from the start: `updated_at` on every mutable row, tombstones for deletions, and `since`/cursor parameters.

## Consequences
- Native apps ship sooner.
- Offline support can be added later without changing the API.
