# 0044. Compatibility API sessions

- Status: Accepted
- Date: 2026-10-07

## Context
The TTRSS and Google Reader APIs (0012) authenticate with app passwords (0035) and hold a session token (TTRSS `sid`, Google Reader `Auth`). Sessions knew nothing of the app password that opened them, so revoking one would leave its clients signed in, and a bearer session from an app password would reach the whole native API. Some clients log in on every sync, and real clients' requests must be observable to build contract tests without TTRSS's code (0009).

## Decision
- A new session kind, `api`, is opened only by an app-password login and records that app password; deleting the app password deletes its sessions. Each app password keeps its 10 most recent sessions. `api` sessions last 90 days, sliding on use.
- `/api/v1` ignores `api` sessions, and the compatibility APIs accept nothing else.
- Each protocol answers in its own shape: TTRSS with HTTP 200 envelopes and its error codes (`API_DISABLED` while a password must be changed), Google Reader with plain-text 401/403/404.
- Credentials travel only in POST bodies, never query strings, which are logged.
- Google Reader's `T` write token is issued but not checked: requests authenticate by header, not cookie, so there is no cross-site forgery to prevent.
- Google Reader routes are also served under `/api/greader.php` for clients that offer only a FreshRSS account type.
- Unsupported calls are logged with the client's user agent; `COMPAT_TRACE` logs every call with credentials redacted, on for the `dev` stage.

## Consequences
- Revoking an app password signs its clients out at once; an app password cannot reach account settings.
- Trace logs hold what clients send (feed URLs, search terms), so tracing stays off in production.
