# 0032. Phase rescoping after P1

- Status: Superseded by 0042
- Date: 2026-10-05

## Context
P1 is complete. Several security-related P2 features matter more than the power features and should ship soon after the AWS deployment. Many P2 features are not needed for daily use.

## Decision
- New phase P1.6 (security and accessibility), after P1.5: image proxy, HTTP-auth feeds, TOTP 2FA, app passwords, and verification of the Accessibility and Security non-functional requirements.
- P2 narrows to labels, tags, notes, published feed, share links, and reading preferences.
- Moved to Later: archived feed, per-feed options, enclosure players, filters, scoring and score sorting, search query syntax, full text, lazy images.
- Publish is recorded as P1, where it shipped.

## Consequences
- App passwords arrive before the TTRSS and Google Reader APIs (P3) that use them.
- Filters, which TTRSS users rely on, are not available at the P3 cut-over unless rescheduled.
