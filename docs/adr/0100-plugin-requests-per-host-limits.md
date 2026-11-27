# 0100. Plugin requests' own per-host limits and time

- Status: Accepted
- Date: 2026-11-27

## Context
A plugin's `fetch` shared the feeds' per-host limits (2 concurrent, ≥ 1 s apart) and ended each request after 60 s, timed from before it waited for a slot. A digest summary reading 4 parts in parallel from one API had 2 wait for the first 2, and parts that took over a minute, or waited most of it, failed: 3 of 4 in one test digest, though `digest.compose` has 5 minutes.

## Decision
- Plugins' requests have per-host limits of their own: 6 concurrent, ≥ 1 s apart, per process. They keep the pauses of feed fetches: a 429, or 503 with `Retry-After`, from either pauses the host for both.
- A plugin's request has no time limit of its own: the hook's `signal` ends it, so a request lasts at most as long as its hook (60 s for events, 5 minutes for `digest.compose`, 30 s for tests and actions), waiting included.

## Consequences
- A plugin can send up to 6 requests at once to a host besides the feeds' 2; hosts that ask to wait are still left alone.
- A hook that waits on one request can spend its whole time on it.
- No change to the plugin API's types; plugin API 0.1.2 servers behave so.
