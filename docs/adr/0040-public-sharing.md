# 0040. Public sharing

- Status: Accepted
- Date: 2026-10-07

## Context
P2 adds a public RSS feed of each user's published entries and per-entry share links that anyone can open without signing in. Both must stay unguessable and revocable, leak nothing about readers, and work on Docker and on AWS, where CloudFront already routes `/public/*` to the API but does not forward the viewer's `Host`.

## Decision
- The server renders both under `/public/*`: a self-contained HTML page per shared entry, with its own script-free CSP, and RSS 2.0 for the feed. The SPA is not involved.
- A share link is a random UUID on the user entry; revoking clears it. Shared entries are kept by purge and unsubscribe like starred ones.
- The published feed is addressed by a 32-byte random key per user in `access_keys`, stored in plain text so the address can be shown again; regenerating replaces it.
- Disabled users' pages and feeds answer 404.
- Images follow the owner's image-proxy preference.
- Absolute URLs come from `PUBLIC_URL`, set to the stage's domain on AWS, else the request's origin.

## Consequences
- Anyone holding a link or feed address can read what it covers, and nothing else, until it is revoked or regenerated.
- A database leak exposes feed keys, which only open published entries.
- Shared entries accumulate until revoked; Settings → Sharing lists them.
