# 0036. HTTP-auth feeds moved to Later

- Status: Accepted
- Date: 2026-10-06

## Context
0032 put HTTP-auth feeds in P1.6. No current subscription needs Basic auth, and supporting it changes the shared-source model (0007): authenticated subscriptions need their own source and the fetcher must carry credentials.

## Decision
- HTTP-auth feeds move from P1.6 to Later.
- P1.6 exits with the image proxy, 2FA, app passwords, and the Accessibility and Security verification.

## Consequences
- P1.6 finishes sooner, with no change to `feed_sources`.
- TTRSS subscriptions with HTTP-auth credentials cannot be imported at the P3 cut-over unless this is rescheduled.
- The `feed-credentials` key from 0034 stays reserved for this feature.
