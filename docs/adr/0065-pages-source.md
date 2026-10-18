# 0065. Pages source

- Status: Accepted
- Date: 2026-10-18

## Context
Every entry belongs to a feed source. The TTRSS importer kept articles that belong to no feed (pages shared to the published feed, starred articles of removed feeds) under a source for their site, `https://host/`, shared by all users. Subscribing to that address attaches to the existing source and backfills its entries, so one user's pages, with any text they typed, reached whoever subscribed to the site. Purge would archive them under the site's address, where its subscribers could read them. Publishing pages from outside the feeds needs the same home.

## Decision
- One hidden feed source, `newses:pages` ("Web pages"), disabled. Its URL is not http(s), so nobody can subscribe to it; it is never fetched and purge never deletes it.
- A page is one user's own entry in it: GUID `page:` + SHA-256 of the user id and normalised URL. Headlines show the link's host as its feed title.
- Purge deletes pages nobody holds without archiving them.
- The importer stores kept articles without a feed there, and never joins one user's page to another's by link.
- A migration moves imported pages out of site sources (sources of imported feeds are left alone), copying each holder's own entry, and deletes the copies other users received by subscribing, unless they kept them.

## Consequences
- Pages no longer reach other users, and are absent from the archive.
- Users who subscribed to a site's address keep that subscription, which fails to fetch if the address is not a feed.
- Pages imported under sources the migration cannot recognise as site sources stay where they are.
