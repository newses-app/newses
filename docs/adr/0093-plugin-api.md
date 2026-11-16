# 0093. Plugin API

- Status: Accepted
- Date: 2026-11-15

## Context
Third-party modules should be able to extend the server (#85). The core runs on Docker and as Lambda bundles the deploy pipeline builds; entries are stored once and shared by their subscribers; the CSP allows no foreign scripts; and the Privacy requirement allows no calls beyond feed, icon, and article fetches. The project's own needs are a webhook when a user's published feed changes (to rebuild a site that reads it) and LLM summaries in the unread digest.

## Decision
- Plugins are npm packages that operators install and that run inside the server, with its privileges and no sandbox.
- Plugin code is bundled at deployment: on AWS from exact versions in the stage's deploy config, at synth, after an audit; on Docker into an image derived from the release image. Enabling a plugin, its settings, and the hosts it may reach change at runtime, in Settings → Plugins.
- This repository holds the host and the contract, `@newses/plugin-api`, published to npm and 0.x (experimental, minors may break) until the project's own plugins run on it. Those plugins live in their own repositories and are installed like anyone else's.
- Hooks are added only when a plugin needs one. Events (`entries.added`, `published.changed`) run as jobs after the change commits, at least once, optionally debounced into one delivery per window. Transforms (`digest.compose`) run inline under a time limit; a failure leaves the input unchanged.
- Plugins get a context, never the database: the polite fetcher limited to the hosts an admin approved for the plugin, a logger without content, key-value storage, settings with secrets sealed with `APP_SECRET`, and the entries an event names, as the user sees them.
- Admins enable plugins and approve their hosts; users set their own settings for plugins with user scope. Settings forms are generated from each plugin's schema; no plugin code reaches the browser.
- Repeated failures disable a plugin and raise an alert.
- `server/src/plugins` implements core ports and is imported only by `entrypoints`.
- A plugin an admin enables may send article data to the hosts the admin approved for it.

## Consequences
- Installing, upgrading, or removing a plugin takes a deployment: a pipeline run on AWS, an image build and restart on Docker.
- A plugin can do anything the server can; the fetcher's limits bind only plugins that use it, so operators install only plugins they trust.
- Plugins running in the server are likely derivative works of an AGPL program.
- Each plugin declares the plugin API version it was written for; an incompatible plugin is refused at startup, never crashing the server.
