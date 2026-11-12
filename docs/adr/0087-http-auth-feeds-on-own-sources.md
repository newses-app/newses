# 0087. HTTP-auth feeds on sources of their own

- Status: Accepted
- Date: 2026-11-11
- Supersedes 0036

## Context
The TTRSS import skips feeds with HTTP authentication, so their readers lose them at the cut-over. 0034 reserved the `feed-credentials` key; 0036 noted that credentials do not fit shared feed sources (0007), where one fetch serves every subscriber.

## Decision
- A Migration and search phase takes HTTP-auth feeds, accent- and form-aware search, and TTRSS's query syntax from Later.
- A subscription with HTTP Basic credentials gets a feed source of its own, holding the login and the password sealed under `feed-credentials` with the source's id as context. `feed_sources.url` is unique only among sources without credentials (a partial index); own sources are never found by URL, shared, or archived.
- Credentials go only to the origin of the feed's URL, never across a redirect elsewhere; an own source adopts permanent redirects within its origin only.
- `POST /subscriptions` and `PATCH /subscriptions/:id` take `credentials`, tried before they are stored; subscriptions show `authLogin`, never the password. TTRSS `subscribeToFeed` takes `login` and `password`. API 1.12.
- `cli reseal-secrets` re-seals feed passwords as well as TOTP secrets.

## Consequences
- The TTRSS import keeps feeds with plain-text passwords; ones sealed with TTRSS's `FEED_CRYPT_KEY` are skipped.
- Several users of one private feed fetch it once each, and adding or removing a login re-delivers the feed's entries as new.
- Losing `APP_SECRET` voids feed passwords too; readers enter them again.
- Passwords never reach the offline outbox, so changing them needs a connection.
