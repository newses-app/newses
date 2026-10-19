# 0073. Kept image cache

- Status: Accepted
- Date: 2026-10-18
- Supersedes 0037

## Context
0037 purges every cached image 30 days after it was fetched, so starred articles lose their images once the publisher removes them, on the server and on devices that store them again. Keeping images of starred entries was listed for Later; a conformance review scheduled it with the requirements still missing. Purge already keeps starred, published, noted, labelled, and shared entries.

## Decision
- The cache keeps the images of every entry purge keeps (starred, published, noted, labelled, or shared), not only starred ones; the feature moves from Later to the Missing requirements phase.
- A periodic sweep lists each kept entry's images (content and full text, at most 30, as offline clients get them) in `entry_images`, again when its content version changes, and fetches those not cached; failures are retried after a day, at most 3 times. It runs every 5 minutes on Docker and with each dispatch on AWS, within 2 minutes.
- Purge forgets the images of entries no longer kept; their cached copies then expire after 30 days as before.
- 0037's other decisions stand: the per-user `proxyImages` preference, signed proxy URLs, fetching through the polite fetcher, public immutable responses, and dropping tracking pixels at ingest.

## Consequences
- Kept entries' images outlive the publisher's copies, in the app and on devices that store them.
- Blob storage grows with kept entries; images over 4 MB are never kept.
- An image reaches the cache up to one sweep after the entry is kept, unless someone views it first.
- The kept set is purge's, which differs from what offline devices keep (unread and starred, ADR 0061).
