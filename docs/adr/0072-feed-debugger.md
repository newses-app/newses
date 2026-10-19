# 0072. Feed debugger

- Status: Accepted
- Date: 2026-10-18

## Context
The feed debugger was listed for Later. When a feed fails, or entries are missing or filtered unexpectedly, users see only the last error; `POST /filters/test` checks rules against stored entries, not what the feed serves now. A conformance review scheduled it with the requirements still missing.

## Decision
- The feed debugger moves from Later to the Missing requirements phase.
- `POST /subscriptions/:id/debug` (API 1.6), for the subscriber, fetches the feed through the polite fetcher without validators and returns the status, headers (without cookies), the body as text (first 256 KB), the parse result or error with any feeds an HTML page advertises, and the entries as ingest would store them, each with the user's enabled filters that would apply.
- Nothing is stored and the feed's schedule is left alone; a host that answers 429 is still paused, and a paused host is reported, not asked.
- The feed dialog opens it; apps offer it against API 1.6 and later.

## Consequences
- Users can see why a feed fails or what their filters would do, without waiting for the next check.
- Each use is one more request to the site, limited per user with the other user-triggered fetches.
