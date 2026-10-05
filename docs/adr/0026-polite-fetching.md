# 0026. Polite fetching

- Status: Superseded by 0030
- Date: 2026-10-04
- Supersedes 0024

## Context
The reader polls third-party sites on behalf of its users. Respecting their resources is a product requirement: overloading a host risks bans and is antisocial. Before this decision, the subscribe check and the first scheduled fetch downloaded every new feed twice, favicons ignored per-host limits, and publisher update hints were not read.

## Decision
- Per host: at most 2 concurrent requests, starts ≥ 1 s apart, shared by feed and favicon fetches.
- The next fetch honours the longer of the configured interval and publisher hints (Cache-Control, Expires, RSS `ttl`, `sy:updatePeriod`), hints capped at 24 h, plus up to 10 % jitter.
- HTTP 429, or 503 with `Retry-After`, pauses the whole host in the worker; `Retry-After` is stored per source as `blocked_until`, and manual refreshes respect it. Refreshes within a minute of the last fetch are no-ops.
- Permanent redirects move the source to the new URL.
- Subscribing ingests the fetch that validated the feed, replacing 0024's "subscribing does not ingest". 0024's other decisions stand: one SSRF-guarded `HttpFetcher`, autodiscovery with a choice for several feeds, unsubscribing keeps starred and published entries.
- Favicons are refreshed every 30 days, reused across feeds of the same site, and limited to 3 candidates and small downloads.
- Users and subscriptions cannot set intervals below 15 minutes.

## Consequences
- Fewer requests per feed; publisher hints can delay updates by up to a day.
- New subscriptions show entries immediately; OPML imports still wait for the first scheduled fetch.
- Host pauses live in worker memory and reset on restart; `blocked_until` persists.
