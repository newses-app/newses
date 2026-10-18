# 0064. Fetch slowdown and site minimum intervals

- Status: Accepted
- Date: 2026-10-17

## Context
A 429 pauses the host for its `Retry-After` (0030), after which its feeds are fetched as often as before, so a site that keeps limiting keeps being asked. Admins cannot slow down one site. A changed interval applies only after the next fetch, which can be days away, and users cannot see why a feed is checked more often than they set.

## Decision
- Each 429, or 503 with `Retry-After`, doubles a slowdown on the feed source (from its interval, at most a day). Five successful fetches in a row halve it; it ends once it no longer lengthens the interval.
- Admins set a minimum interval per host on the Operations page, recorded in the audit log.
- A source's interval is the longest of its subscribers' shortest interval, the publisher hint (at most a day), the slowdown, and the site minimum. The source records which set it.
- Changes to a subscription's interval or pause, a user's default interval, subscribing, unsubscribing, and site minimums reschedule the feed at once: to its last fetch plus the new interval, never before now; failing, new, and imminent fetches keep their time.
- Subscriptions report the interval in effect, why, and the next check, but not other subscribers' settings; paused ones report neither.

## Consequences
- Sites that keep rate limiting are asked less often until they answer normally.
- A site minimum overrides users' shorter intervals for every feed of the host.
