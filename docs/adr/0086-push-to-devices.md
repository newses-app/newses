# 0086. Push to devices

- Status: Accepted
- Date: 2026-11-10

## Context
Closed apps learn about new entries only on 30-minute timers (Periodic Background Sync, WorkManager), and only the desktop and Android apps notify. Vendor push (FCM, APNs, and SNS or AWS End User Messaging over them) needs an account and credentials per deployment, a Firebase project baked into the APK, and cannot reach browsers or UnifiedPush. Web Push (RFC 8030, 8291, 8292) needs no account: browsers' push services and UnifiedPush distributors (such as a self-hosted ntfy) take the same encrypted, VAPID-signed request.

## Decision
- The server sends Web Push only, to any endpoint a device subscribes with; no FCM, APNs, or SNS.
- The VAPID key is derived from `APP_SECRET` (`vapid`), with no new configuration; `GET /server` gives its public key as `push.key`. API 1.11.
- `PUT /push/subscription` binds one subscription to the calling session, which removes it when it ends; `DELETE` removes it.
- Endpoints are https and get the feed fetcher's private-address guard; 404 and 410 delete the subscription.
- Ingest pushes the user's new unread entries a fetch found: one message per user per 30-minute window (ending 3 minutes early), the rest sent once it ends. The message counts entries by place and names the stream to open; devices word it.
- Encryption and VAPID signing use `node:crypto`, checked against RFC 8291's example.

## Consequences
- Browsers' vendors relay the messages, which they cannot read; no account or key is set up.
- Browsers show a notification for every message, so web push is opt-in notification of new entries.
- Restoring a bundle to another instance changes the key; devices subscribe again when `push.key` changes.
- On AWS, the first fetch of a dispatch cycle to find entries pushes them; the rest of that cycle's go out with the next dispatch.
