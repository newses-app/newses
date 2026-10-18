# 0063. Per-feed options

- Status: Accepted
- Date: 2026-10-17

## Context
Per-feed options were in Later: hide from All articles, pause updates, always show images. Feed sources are shared (0007), so one user's pause cannot stop a feed others follow. Nothing hides images, so "always show images" has nothing to override. Full text per feed shipped in P3 (0050).

## Decision
- New phase Per-feed Options: pause updates and hide from All articles, per subscription.
- A paused subscription no longer counts toward its feed's interval; a feed whose subscriptions are all paused is not fetched. It still receives what other subscriptions' fetches bring, and "Update now" still fetches.
- A subscription hidden from All articles is left out of All articles and Fresh: their lists, counts, catch-up, and search, in the web app, its offline store, the TTRSS API (feeds −4 and −3), and the Google Reader reading list. Its own feed, its categories, Starred, Published, labels, and tags still show it.
- "Always show images" is dropped.
- The TTRSS importer imports "updates disabled" as paused.

## Consequences
- Pausing a feed others follow saves no requests.
- Google Reader clients that sync the reading list, such as ReadYou, show no articles of hidden feeds.
- API 1.4 adds the options to subscriptions.
