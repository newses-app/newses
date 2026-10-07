# 0043. Entry scores

- Status: Accepted
- Date: 2026-10-07

## Context
Scoring joins P3 (0042). TTRSS ties fixed actions to score ranges: below −500 an entry is marked read, below 0 it leaves Fresh, above 1000 it is starred; nothing is hidden. The requirement asks instead for configurable thresholds that highlight and hide entries.

## Decision
- `user_entries.score` is an integer, 0 by default, within ±1,000,000, set by the user (and by filters once they exist).
- `scoreHighlightAbove` (default 0) highlights entries in lists. `scoreHideBelow` (default −500) leaves entries out of subscription, category, All, and Fresh lists and their unread counts. Starred, Published, labels, tags, and Recently read show every score, because the user picked those entries out. Catch-up still marks hidden entries read.
- Scores have no automatic effects: nothing is marked read, starred, or left out of Fresh because of its score.

## Consequences
- Imported TTRSS scores keep their values but not TTRSS's automatic actions; filters mark entries read or star them explicitly.
- A hidden entry stays unread, uncounted, until it is caught up or purged.
- List and counter queries filter rows on the user's threshold; no index is needed while most scores are 0.
