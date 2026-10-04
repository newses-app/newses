# 0008. Local authentication

- Status: Accepted
- Date: 2026-10-03

## Context
A small group of users needs secure logins on web, desktop, mobile, and third-party API clients. OIDC and reverse-proxy authentication were considered and not needed.

## Decision
A built-in auth module providing:
- Argon2id password hashes.
- DB-backed sessions: cookies with CSRF protection for web, bearer tokens for apps.
- Optional TOTP.
- Revocable app passwords for TTRSS and Google Reader clients.
- Admin-created accounts only.

## Consequences
- No external identity dependency.
- Auth code is owned and must be carefully tested.
- SSO can be added later through a new ADR.
