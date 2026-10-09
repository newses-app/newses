# 0050. Full text

- Status: Accepted
- Date: 2026-10-08

## Context
Full text (P3, 0042) replaces short feed summaries with the article from the linked page, on demand and for opted-in feeds. Fetching pages must follow the same politeness rules as feeds, and on AWS nothing may run all the time. Entries are shared between users, while opt-ins are per subscription.

## Decision
- Extraction uses Readability on linkedom; the result is sanitised like feed content and stored on the shared entry beside the original, which is kept and remains what search indexes.
- An `entry.extract` job per feed source handles its newest untried entries, queued after a fetch adds entries when any subscriber opted in, and when one opts in. On AWS it is an SQS queue and an `extract` function; on Docker a pg-boss job.
- Page fetches go through the host limiter; failures are recorded per entry and not retried by jobs. On-demand requests retry.
- Opted-in subscriptions show the full text first, with a toggle to the feed's content; compatibility clients get it in place of the content.

## Consequences
- One extraction serves every subscriber of a feed.
- A user who extracts an article on demand caches it for others, who still see the feed's content unless they opted in.
- Pages that need scripts to render yield no article.
