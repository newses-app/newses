# 0095. Test digests, previewed with plugins' estimates

- Status: Accepted
- Date: 2026-11-24

## Context
A user checking a plugin that adds to digests, such as the digest summary, could only wait for their next digest, and Send test ran only the plugin's own check. A digest's additions can cost money (the digest summary reads up to 2,000 entries with Claude), and nothing said what a digest would cost before it was sent. Plugins get API functions only where the core has the function they extend.

## Decision
- The core sends a test digest on request (`POST /account/digest/test`): the unread entries shown in All from the last 24 hours, with the additions of the plugins on for the user, not counted toward turning them off, and why any added nothing; it leaves the digest schedule and read state alone. The worker, or on AWS the `plugin` function, sends it within a minute.
- The core previews one first (`GET /account/digest/test`): how many entries it would hold, and each plugin's estimate from a new hook, `digest.estimate`, given what `digest.compose` would get, making no billed requests, under 10 s; plugins without it show no estimate.
- Settings → Account → Digest and a user's Send test of a plugin with `digest.compose` show the preview, then Send or Cancel. `Plugin.digests` says which plugins add to digests.
- `digest.estimate` is part of plugin API 0.1.1.

## Consequences
- Previews run plugins' code in the API process (and the `api` function on AWS), and the `plugin` function sends mail.
- An estimate is the plugin's own; the digest summary prices its requests from list prices it carries, which change only with its releases.
