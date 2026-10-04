# 0024. Feed fetching safety and subscription lifecycle

- Status: Superseded by 0026
- Date: 2026-10-04

## Context
The server fetches URLs users type in, which is an SSRF risk on a home network. Subscriptions must work for feed URLs and web pages. TTRSS keeps starred articles of unsubscribed feeds.

## Decision
- One `HttpFetcher` (undici) for all outbound feed requests. It enforces timeouts and size and redirect limits, and refuses private addresses unless allow-listed. The address check runs inside the connection's DNS lookup, not before the request.
- Subscribing validates the feed but does not ingest entries. Ingest belongs to the updater.
- Page URLs use `<link rel="alternate">` autodiscovery. Several feeds return a choice rather than an automatic pick.
- Unsubscribing keeps starred and published entries.
- Feed autodiscovery uses `htmlparser2` rather than a DOM library.

## Consequences
- LAN feeds need `FETCH_ALLOW_PRIVATE_NETWORKS`.
- New subscriptions show no entries until the first scheduled fetch.
- Kept entries of unsubscribed feeds appear only in Starred/Published until the Archived view (P2).
