# 0019. Feed parser: feedsmith

- Status: Accepted
- Date: 2026-10-03

## Context
A spike compared `feedsmith` 3.0, `@rowanmanning/feed-parser` 2.1, and `rss-parser` 3.13 (baseline). The test set was 15 hand-written edge-case feeds plus 15 real-world feeds covering RSS 0.91/2.0, Atom 0.3/1.0, RDF, JSON Feed, and podcasts.
- Edge-case checks: feedsmith 47/48, rowanmanning 41/48 (no JSON Feed), rss-parser 35/48.
- Speed with all fields read: feedsmith 24 ms on a 4.4 MB feed, rowanmanning 1.6 s. On typical feeds both take a few milliseconds.
- feedsmith also parses OPML.
- rowanmanning recovers structurally broken XML (unescaped `<`, mismatched tags, truncation), sometimes losing data; feedsmith rejects it.
- rss-parser has been unmaintained since 2023.

## Decision
- Use `feedsmith` for feeds and OPML, with our own per-format mapping to the entry model.
- XML that feedsmith cannot parse is treated as a fetch error, as in TTRSS. No fallback parser.
- Byte decoding and lenient date parsing are our responsibility.

## Consequences
- One fast parser covering every format, plus OPML import/export.
- Feeds with broken XML are unreadable until the publisher fixes them, and show in the feed-errors view.
- The mapping code (~70 lines) must track feedsmith's format-specific types across upgrades.
