# 0094. Digest summary as one overview of every unread entry

- Status: Accepted
- Date: 2026-11-23

## Context
The digest summary plugin (#190) was built to summarise each entry from its full text as it arrived, in Message Batches, and to open the digest with an overview of the entries the digest lists, at most 100. What readers want from it is what their unread entries have in common, across feeds and beyond the 100 a digest lists, from the feeds they choose. Plugins got only the listed entries, and plugin settings could not name a user's feeds.

## Decision
- The digest summary plugin writes one overview: the common themes of the unread entries the digest counts, then other notable stories, from their titles and excerpts. It no longer summarises entries one by one or reads their full text.
- Each user chooses all their feeds, only some, or all but some.
- `digest.compose` also gets `unlisted`: the unread entries the digest counts but does not list, at most 2,000, newest first, as listed entries are given.
- `feeds()` is a settings field of top-level user settings holding subscription ids, which the web app edits as a picker of the user's subscriptions.
- Both are additions to the plugin API, published as 0.1.1.

## Consequences
- A digest's overview can cost tens of thousands of input tokens; the plugin sends large digests in chunks within the 60 s limit, and the monthly token budgets bound it.
- Reading up to 2,000 more entries adds a query to each digest sent while a plugin composes digests.
- Plugins needing `unlisted` or `feeds()` declare `apiVersion` `^0.1.1`, and servers with 0.1.0 refuse them.
