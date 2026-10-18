# 0068. Share entry points

- Status: Accepted
- Date: 2026-10-18

## Context
Pages can be published from the web app and TTRSS clients (0066), but users find them while browsing elsewhere. Bookmarklets were not scheduled, Android's share sheet only subscribed, and installed web apps were not share targets. A bookmarklet runs on another site, so it cannot call the API with the user's cookie and CSRF token.

## Decision
- The web app's `/publish`, `/subscribe`, and `/share` addresses fill in the Publish or Subscribe dialog, or offer a shared page to subscribe to or publish; they go through sign-in like any route and never act on their own.
- Bookmarklets in Settings → Sharing open them for the current page in a small window from the server's origin, with its title and up to 2,000 characters of selected text; the window closes once the page is published.
- The Android share sheet and installed web apps (manifest `share_target`) offer shared pages to subscribe to or publish, titled by the share's subject or text. Against servers before API 1.5 the app subscribes, as before.

## Consequences
- Bookmarklets and share targets need no credentials of their own; a link can at most prefill a dialog.
- Selected text past 2,000 characters is cut, as addresses must stay within proxies' limits.
- Bookmarklets do not run inside the app, whose CSP blocks them; they are dragged to the bookmarks bar or copied.
