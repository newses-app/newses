# 0099. Digest sections citing entries, linked by the server

- Status: Accepted
- Date: 2026-11-25

## Context
The digest summary plugin should organise its overview into topic sections (world, politics, technology, sports…), each point linking the articles it draws on, with sections, length, style, and instructions each user chooses. `digest.compose` returned only plain text, which the digest escapes: no headings, and no links. Letting plugins return links or HTML would let text a feed wrote, passed through a model, put any URL in a user's mail.

## Decision
- `digest.compose` may also return `sections`: each a heading and points, as paragraphs or a list, each point citing entries by id.
- Plugins cite entries, never URLs: the server keeps only ids of the entries it gave the plugin (listed or unlisted) and links each by its title to the entry in the web app, as the digest's own titles are.
- Limits: 12 sections, headings of 80 characters, 8 points a section, points of 600 characters citing at most 5 entries, and 8,000 characters of headings and points together.
- An addition to the plugin API, published as 0.1.2.

## Consequences
- A digest can link entries it does not list, from `unlisted`; they open in the web app.
- Plugins using `sections` declare `apiVersion` `^0.1.2`, and servers with 0.1.1 refuse them.
- The digest summary plugin's customisation is its own settings; the plugin API gains nothing for it.
