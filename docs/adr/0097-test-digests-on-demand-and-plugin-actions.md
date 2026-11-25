# 0097. Test digests on demand, and plugin actions

- Status: Accepted
- Date: 2026-11-24
- Supersedes 0096

## Context
Test digests were delivered like plugin deliveries: a `digest_tests` table, a worker task every 30 s, a step in each tick dispatch, and the AWS `plugin` function sending mail. That machinery exists for retries and debounce windows; a test email needs neither. The cost estimate (0096) put one kind of plugin's meaning, tokens and US dollars, into the plugin API, a route, and a web component, though the core has no notion of cost; plugins get API functions only where the core has the function they extend.

## Decision
- A test digest is sent in the background once asked for and checked: on Docker by the server process after answering, on AWS by the `tick` function, which the `api` function invokes asynchronously. There is no table, poller, or schedule; one that fails is logged, not retried. The `plugin` function sends no mail.
- `digest.estimate` is replaced by plugin actions, which generalise Send test: buttons labelled by the plugin's messages, run as a test is, reporting `{ ok, message }`. An action with `digest` is given the test digest's `digest.compose` input. The digest summary's Estimate cost is such an action, wording and pricing its own estimate.
- Both are in plugin API 0.1.1 and server API 1.17.

## Consequences
- Migration 0052 drops `digest_tests`.
- A Docker restart while a test digest is composed loses it.
- Plugins can add buttons without new core contracts; the core shows their plain text as written.
