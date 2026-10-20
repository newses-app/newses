# 0076. Session end clears offline data

- Status: Accepted
- Date: 2026-10-19

## Context
OWASP ASVS V14.3.1 asks that authenticated data leave client storage once the session ends. Signing out deletes the offline store (0061), but a session that ends otherwise (expired, revoked from another device, a password reset, a disabled user) only forgot the token: articles, notes, and labels stayed in IndexedDB until the next sign-in or sign-out. The store's outbox may hold changes made offline that the server has not seen.

## Decision
- When the server ends a session without a sign-out on the device (a 401 outside sign-in forms), the profile's store keeps only its outbox; entries, text, images, snapshots, and the sync position are deleted. A store with nothing waiting is deleted whole.
- The same user signing in again sends the waiting changes and downloads the store again. The outbox stays until then, or until the profile signs out or is removed.
- Each profile is cleared when the app finds its session ended: in the app, the browser's service worker, or the Android background job. Inactive profiles are not checked in the background.
- In the browser, signing out and session end also delete the feed-icon cache.

## Consequences
- A revoked device keeps nothing readable once it next reaches the server; until then (offline start), the store shows as before.
- Changes made offline survive a session expiring, but stay on the device unencrypted until the user signs in again.
- After signing in again, the store downloads in full.
