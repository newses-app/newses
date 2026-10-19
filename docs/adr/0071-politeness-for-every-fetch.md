# 0071. Politeness for every fetch, host leases, and per-user fetch limits

- Status: Accepted
- Date: 2026-10-18
- Supersedes 0030

## Context
0030 batches feed fetches per host and shares host pauses through `fetch_hosts`, but only feed fetches recorded or checked pauses; subscribe ignored them and the per-host limiter, and favicons ignored pauses. SQS does not deduplicate jobs, and pg-boss lets a queued job start beside a running one, so a host's feed jobs overlapped across processes. Users could make the server fetch without limit through on-demand full text, subscribe, and publish.

## Decision
- Every request to a remote host goes through one polite fetcher: the per-host limiter (2 concurrent, ≥ 1 s apart, per process), no request while the host is paused, and a 429, or 503 with `Retry-After`, from any fetch pauses the host that answered in `fetch_hosts`.
- A `feed.fetch` job holds its host's lease in `fetch_hosts` (2 minutes, renewed before each source). A job that finds the host leased keeps its sources claimed and is queued again a minute later.
- Per user, on-demand full text, subscribing to a new feed, reading a page to publish, and the feed debugger are limited per minute, counted in Postgres; past the limit requests get 429, except publishing, which goes ahead without reading the page.
- 0030's other decisions stand: dispatch groups at most 20 claimed sources per host into one job, deduplicated by host where the queue can; sources that cannot join stay due; purge forgets expired rows.

## Consequences
- No two processes work through a host's feeds at once; a waiting job costs a queue round trip a minute.
- Images, favicons, and full text are still limited per process, not across processes.
- A 429 from any purpose pauses the host's feeds too.
