# 0066. Published pages

- Status: Accepted
- Date: 2026-10-18

## Context
The published feed only holds entries of the user's feeds. TTRSS clients share any page to it with `shareToPublished`, and bookmarklets and the Android share sheet need the same. Pages live in the pages source (0065), one entry per user and address. Users rarely type a page's title or text, and an unpublished page has no subscription, so neither purge nor unsubscribing handled it.

## Decision
- `POST /api/v1/published-feed/pages` (API 1.5) takes an http(s) address, an optional title, and optional plain text (it becomes paragraphs); all are sanitised.
- A missing title or text is read from the page with Readability, fetched within the per-host limits and host pauses. A page that cannot be read is published all the same, titled with its address.
- Publishing an address again replaces what is given, reads the page again for the rest (keeping what was stored when it cannot), republishes it, and moves it to the top.
- The page is read and published, with no subscription, and stays while kept.
- Purge deletes user entries without a subscription that are no longer kept once they have been unchanged for the user's purge age. Unsubscribing deletes only that feed's entries.

## Consequences
- Publishing waits for the page fetch, up to the fetcher's 20 s timeout.
- Republishing without text replaces text typed earlier with the page's article.
- Kept entries of unsubscribed feeds that stop being kept are purged by age too, rather than at the next unsubscription.
- Pages show in All articles and search like other entries.
