# 0039. Labels, tags, and notes

- Status: Accepted
- Date: 2026-10-07

## Context
P2 adds per-user notes, labels, and tags on entries. Clients sync entries through `user_entries.updated_at` and tombstones (0027), search must stay fast on millions of entries, and purge must not delete entries a user has annotated. Feeds already provide categories, which TTRSS imports as tags.

## Decision
- A note is a plain-text column on `user_entries`, null when empty. Search matches notes through a partial GIN index on `to_tsvector('simple', note)`; notes do not count towards search selectivity.
- Labels are per-user rows with colours, assigned through `entry_labels`. Each label is a stream with an unread counter; deleting a label leaves a tombstone.
- Tags are `(user entry, tag)` rows, normalised (trimmed, lower-case, no commas). Feed categories are copied as tags when an entry is fanned out to a user; later edits are the user's and are never overwritten by re-ingest.
- Label and tag rows live in their own tables. Statement-level triggers bump the owning `user_entries.updated_at`, so sync carries label ids and tags on the entry, including after cascades.
- Purge and unsubscribe keep noted and labelled entries, alongside starred and published ones.

## Consequences
- Sync and headline lists need no new paging; entries grow by a note, label ids, and tags.
- Feeds with many categories create many tags; tags are browsed through a picker, not the feed tree.
- Annotated entries are kept until the user removes the note or labels.
