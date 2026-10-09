# 0048. Imported entry identity

- Status: Accepted
- Date: 2026-10-08

## Context
TTRSS gives each user their own copy of an article, under a GUID it derives per owner, not the feed's GUID. Imported entries must be shared between users like fetched ones, and must not come back as duplicates when the feed is fetched here.

## Decision
- Copies with the same feed source, title, link, and content become one entry, whose GUID is `ttrss:` and that content hash. Re-runs land on the same entries.
- Ingest gives a new item an imported entry in the same source with the same link, the newest if several, before storing it. The entry takes the feed's GUID and current content; no user is delivered it again.
- A partial index on (feed source, link) over `ttrss:` GUIDs keeps that lookup cheap, and it empties as entries are taken over.
- Entries that purge would delete at once are not imported. Archived feeds' entries are kept without a subscription until archived feeds exist.

## Consequences
- Articles whose link changed in the feed, or that left the feed, keep their `ttrss:` GUID for good.
- Imported entries look like fetched ones to every other part of the system.
