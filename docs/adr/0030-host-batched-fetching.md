# 0030. Host-batched fetching and persisted host cooldowns

- Status: Accepted
- Date: 2026-10-05
- Supersedes 0026

## Context
0026 enforced per-host politeness with an in-memory limiter and paused throttling hosts in worker memory. That holds only while one long-lived process does all fetching; serverless workers (P1.5) are many short-lived processes that share no memory.

## Decision
- Dispatch groups claimed sources by host, at most 20 per host, into one `feed.fetch` job per host, deduplicated by host. The job fetches its sources one after another, starts ≥ 1 s apart. Sources that cannot join a host's queued job stay due.
- HTTP 429, or 503 with `Retry-After`, records the host in `fetch_hosts.blocked_until`; every process skips the host's sources until then. Purge forgets expired rows.
- The in-process limiter (2 concurrent, ≥ 1 s apart per host) still covers favicons and overlapping jobs within one process.
- 0026's other decisions stand: publisher hints, per-source `blocked_until`, refresh rules, permanent redirects, ingesting the subscribe fetch, favicon reuse, 15-minute minimum interval.

## Consequences
- Politeness holds across any number of worker processes.
- A host with many due feeds is fetched over several dispatches.
- Host pauses survive restarts.
