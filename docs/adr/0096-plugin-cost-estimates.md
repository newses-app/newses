# 0096. Plugins' cost estimates apart from test digests

- Status: Accepted
- Date: 2026-11-24
- Supersedes 0095

## Context
0095 put a preview in front of every test digest: Settings → Account → Digest and a plugin's Send test showed how many entries it would hold and each plugin's estimated cost, then Send or Cancel. That mixed a plugin's cost into the core's test digest, which should send at once and know nothing of costs.

## Decision
- The core sends a test digest on request (`POST /account/digest/test`), at once, as 0095 describes it otherwise: the unread entries shown in All from the last 24 hours, with the additions of the plugins on for the user, not counted toward turning them off, and why any added nothing, leaving the schedule and read state alone. A user's Send test of a plugin with `digest.compose` sends one once the plugin's own check passes. There is no preview.
- A plugin with `digest.estimate` (plugin API 0.1.1, only beside `digest.compose`) has "Estimate cost" under "For me" in Settings → Plugins (`Plugin.estimates`). `POST /account/plugins/:id/estimate` runs that plugin's `digest.estimate` on what `digest.compose` would get for a test digest now, under 10 s, not counted toward turning it off, sending nothing, and answers the digest's entry count with the plugin's tokens, US dollars, and note.

## Consequences
- Estimates run plugins' code in the API process (and the `api` function on AWS); the `plugin` function sends test digests' mail.
- An estimate is the plugin's own; the digest summary prices its requests from list prices it carries, which change only with its releases.
