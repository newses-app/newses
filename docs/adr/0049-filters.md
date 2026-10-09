# 0049. Filters

- Status: Accepted
- Date: 2026-10-08

## Context
Filters (P3, 0042) run user-written regular expressions on the server against every new article for every user. TTRSS uses PCRE, which can backtrack exponentially on some patterns and inputs; one such pattern would stall fetching for everyone. TTRSS filters match without regard to case.

## Decision
- Patterns use RE2 syntax through re2js, a pure-JavaScript port with linear-time matching and no native build. Lookarounds and backreferences are not available.
- Matching ignores case; `(?-i)` turns that off within a pattern.
- Filters run at delivery, after fan-out and in its transaction, for fetched entries and a new subscription's backfill. Imported entries are not filtered.
- Matching filters' actions combine in order until `stop`; deleting an entry removes the user's copy.
- Applying a filter to existing entries never deletes kept entries, and runs in time-boxed calls continued by cursor so it fits the API's limits on AWS.

## Consequences
- No filter can stall the server, whatever its pattern.
- TTRSS patterns using lookarounds or backreferences cannot be imported as they are.
- Ingest does a little more work for users with filters, in the fetch transaction.
