# 0023. Session and login security

- Status: Accepted
- Date: 2026-10-04

## Context
Web, desktop, and mobile clients share one API. Login throttling must hold across several server instances on Fargate. Cookie sessions need CSRF protection, but the SPA has no server-rendered forms.

## Decision
- Opaque random session tokens, stored hashed in `sessions`: an httpOnly SameSite=Lax cookie for the web, a bearer token for apps. No JWTs, so revocation takes effect immediately.
- CSRF uses a per-session synchronizer token returned at login and by `GET /auth/session`, and required in `X-CSRF-Token` on unsafe cookie requests. Login accepts JSON only.
- Login throttling is stored in Postgres (`login_attempts`), keyed per account and per IP, with exponentially growing lockouts.
- The first admin comes from `ADMIN_LOGIN`/`ADMIN_PASSWORD` on an empty database, or from `cli user create --admin`.

## Consequences
- Every authenticated request does a session lookup (indexed by token hash). Expiry is extended at most hourly.
- Throttling works across instances without Redis.
- A shared household IP gets a higher allowance than a single account.
- Correct client IPs behind a proxy require `TRUST_PROXY`.
