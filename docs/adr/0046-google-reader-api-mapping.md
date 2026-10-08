# 0046. Google Reader API mapping

- Status: Accepted
- Date: 2026-10-07

## Context
The Google Reader API (0012) names feeds, folders, tags, and items by string ids, and its clients sync by listing item ids per state and fetching the missing items. Folders and tags share one `user/-/label/` namespace, which here holds nested categories and labels.

## Decision
- Feeds are `feed/<subscription id>`, so a feed's id survives URL changes; `feed/<URL>` is accepted where clients pass URLs.
- Folders are categories named by their path (`Parent/Child`); labels are tags. On a name clash the folder wins and the label is hidden from the API.
- Item ids are `user_entries` ids, in long hex and decimal forms.
- Item id lists come from a query that reads no entry text, up to 10,000 per page with continuation.
- `ot`/`nt` bound the entry's sort time; `mark-all-as-read`'s `ts` bounds when the user received entries, so items arriving after the client's view stay unread.
- Unknown folders and tags named by writes are created.

## Consequences
- A label that shares a folder's name is reachable only in the web app and the TTRSS API.
- Entries published long before they were fetched fall before an incremental sync's `ot`; clients that reconcile with the full unread id list still see them.
