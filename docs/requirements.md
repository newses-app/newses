# Requirements

## Phases

| Phase | Scope | Exit criteria |
|---|---|---|
| P1 | MVP reader, self-hosted | Family members read daily feeds in the web app on a Docker deployment; OPML from TTRSS imported |
| P1.5 | AWS deployment | P1 build runs serverless on the AWS `dev` stage, deployed by the CDK pipeline from the `dev` branch |
| P1.6 | Security and accessibility | Image proxy, 2FA, and app passwords in daily use; Accessibility and Security non-functional requirements verified on the AWS `dev` stage |
| P2 | Power features | Labels, tags, notes, published feed, share links, reading preferences, and remappable shortcuts in daily use |
| P3 | TTRSS cut-over | All TTRSS users imported; filters, scoring, and full text in daily use; TTRSS and Google Reader clients work against the server; TTRSS retired |
| P4 | Native apps | Signed Electron apps for Windows and Linux and the Capacitor Android app installed from the stage's downloads, used against AWS and Docker servers, and updating themselves |
| P5 | Cold-storage archive | Articles purge deletes and the TTRSS import drops are kept; users browse, search, and restore them on Docker and AWS |
| Observability | Operations insight | Admins follow user activity, load on remote sites, job health, and security events on the Operations page and get alert emails; on Docker they trace requests and jobs in Grafana, on AWS in X-Ray, with a monthly cost budget |
| Custom Themes | Appearance | Users adjust the appearance, save, import, export, and share their own themes, and use the Terminal and Sketch themes in the web, desktop, and Android apps |
| Offline Reading | Offline use | Family members read and search unread and starred articles with images in the web, desktop, and Android apps without a connection; changes made offline reach the server on reconnect without overriding newer ones; installed Chromium PWAs and the Android app sync in the background; on Docker and AWS |
| Per-feed Options | Feed control | Family members pause feeds and hide them from All articles in the web, desktop, and Android apps, and see how often each feed is checked and why; feeds of rate-limiting sites slow down on their own, and admins set per-site minimum intervals; on Docker and AWS |
| Published pages | Sharing | Family members publish any web page to their published feed from the web, desktop, and Android apps, bookmarklets, and TTRSS clients; imported pages stay private to their owner; on Docker and AWS |
| Missing requirements | Conformance | Feed errors show when they happened; logs below debug carry no secret keys or feed URLs; every fetch honours host pauses and a host's feeds are never fetched by two processes at once; family members debug feeds and keep the images of kept entries; OWASP ASVS L1 verified again; on Docker and AWS |
| Multiple Server Profiles | Native apps | Family members keep several servers and accounts in the desktop and Android apps and switch between them without signing in again, keeping each one's offline articles and waiting changes; on Docker and AWS |
| Later | Backlog | Not scheduled |

## Features

### Feeds

| Feature | Phase | Acceptance criteria |
|---|---|---|
| Subscribe by URL | P1 | Accepts a feed URL or a web page URL; page URLs resolve via `<link rel="alternate">` autodiscovery, prompting when several feeds are found |
| Feed formats | P1 | RSS 0.9x/2.0, RSS 1.0/RDF, Atom 0.3/1.0, JSON Feed 1.x parse into the same entry model, including media/enclosure elements |
| Categories | P1 | Nested categories; create, rename, delete, reorder, collapse one or all, move feeds by drag and drop |
| OPML import/export | P1 | Round-trips feeds and nested categories; imports a TTRSS OPML export without loss of feed URLs or category structure |
| Background updates | P1 | Per-feed interval (default global setting); conditional GET via ETag/Last-Modified; exponential backoff on failure; honours `Retry-After`/HTTP 429; manual "update now" |
| Feed errors | P1 | Last error and time shown per feed; "feeds with errors" view; feed auto-disables after a configurable number of consecutive failures |
| Favicons | P1 | Fetched per site, cached, shown in tree, headlines, and article headers; fallback icon |
| Purge policy | P1 | Global and per-feed max age; never purges starred, published, noted, labelled, or shared entries; entries outside any feed (published pages, kept entries of unsubscribed feeds) are purged by age once no longer kept |
| HTTP-auth feeds | Later | Basic auth credentials per subscription, encrypted at rest |
| Per-feed options | Per-feed Options | Pause updates: the feed is no longer checked for the user, who still gets what others' checks bring. Hide from All articles: left out of All articles and Fresh, their counts, catch-up, and search, also through the TTRSS and Google Reader APIs. The feed's settings show how often it is checked, why, and when next; a changed interval applies at once |
| Rate-limit slowdown | Per-feed Options | A feed answering HTTP 429 is checked less often, and back to normal after a run of successful checks; admins set a minimum interval per site on the Operations page |
| Feed debugger | Missing requirements | Dry-run fetch shows raw response, parsed entries, and filter matches |
| Generated feeds | Later | Secret-key RSS feed for any feed, category, or label |
| WebSub | Later | Push subscriptions for hubs advertised by feeds |

### Reading

| Feature | Phase | Acceptance criteria |
|---|---|---|
| Special feeds | P1 | All articles, Fresh (configurable age), Starred, Published, Recently read, each with unread counts |
| Archive | P5 | Past articles of subscribed feeds (purged, or older than the subscription) can be browsed per feed and searched; starring, publishing, noting, or labelling one restores it to the feed |
| Archived feed | Later | Starred/published/noted entries of unsubscribed feeds remain readable under "Archived" |
| Layouts | P1 | Three-pane (tree / headlines / article) and combined (expanded articles in list) modes; single-pane responsive layout below tablet width, where returning from an article keeps the list's position |
| View modes | P1 | All, unread only, adaptive (unread if any, else all) |
| Sorting | P1 | Newest first, oldest first, title |
| Score sorting | Later | Sort by score, then date |
| Read state | P1 | Mark read on open; optional mark read on scroll in combined mode; toggle unread |
| Catch-up | P1 | Mark feed/category/special feed read: all, or older than 1 day / 1 week / 2 weeks |
| Live counters | P1 | Unread counts update without reload within 5 s of ingest (SSE), falling back to polling when the stream is unavailable |
| Keyboard shortcuts | P1 | TTRSS default bindings (`j`/`k`, `n`/`p`, `s`, `u`, `o`, `/`, `f a`, `g a`, …); `?` shows a help overlay |
| Remappable shortcuts | P2 | Per-user keys or two-key sequences per action; settings record them, flag clashes, and reset to defaults; the help overlay shows the user's bindings |
| Themes | P1 | Light, dark, follow system |
| Custom themes | Custom Themes | Built-in Original, Terminal, and Sketch themes; per-user adjustments of colours, fonts, text scale, corners, density, borders, shadows, and effects; named themes saved, renamed, duplicated, deleted, imported, and exported as JSON; themes published to everyone on the server, which admins can unpublish; built-in palettes meet WCAG AA, and others warn below it |
| Reading preferences | P2 | Font family, size, line width per user |
| Enclosures | Later | Inline audio/video players and image galleries for enclosures |
| Open original | P1 | Opens article link in a new tab/browser without marking unrelated items |

### Organisation

| Feature | Phase | Acceptance criteria |
|---|---|---|
| Star | P1 | Toggle from list or article; Starred special feed |
| Publish | P1 | Toggle published; Published special feed |
| Labels | P2 | User-defined labels with foreground/background colour; assign many per entry; each label appears as a virtual feed with counts |
| Tags | P2 | Free-text tags per entry (feed-provided categories imported as tags); browse entries by tag |
| Notes | P2 | Plain-text note per entry, shown in list and article; searchable |
| Filters | P3 | Rules match title, content, title-or-content, author, link, or tags by regex, optionally inverted; match any/all rules; scoped to all feeds or selected feeds/categories; actions: delete, mark read, star, publish, assign label, add tag, adjust score, stop processing; run on ingest; "test" previews matches; "apply" runs against existing entries |
| Scoring | P3 | Integer score per entry; entries above/below configurable thresholds are highlighted/hidden |

### Search

| Feature | Phase | Acceptance criteria |
|---|---|---|
| Full-text search | P1 | Searches title and content within current feed, category, or all; ranked results |
| Query syntax | Later | `title:`, `author:`, `note:`, `tag:`, `label:`, `unread:true/false`, `star:true/false`, `pub:true/false`, `@YYYY-MM-DD` and relative dates; negation with `-` |

### Sharing

| Feature | Phase | Acceptance criteria |
|---|---|---|
| Published feed | P2 | Per-user public RSS feed of published entries at a secret-key URL; key can be regenerated |
| Share link | P2 | Per-entry public read-only URL (unguessable UUID); can be revoked |
| Publish a page | Published pages | Any web page joins the user's published feed with an optional title and text; a missing title or text is taken from the page, and a page that cannot be read is still published; publishing the same address again updates it; works from Settings and TTRSS clients |
| Bookmarklets | Published pages | "Subscribe in Newses" and "Publish in Newses" bookmarklets in Settings → Sharing open the app's Subscribe or Publish dialog filled in with the page (its title and selected text), through sign-in, without acting on their own |
| Share to the app | Published pages | Pages shared from other apps to the Android app or an installed web app are offered to subscribe to or publish, with the page's title |
| Email | Later | Email an article; scheduled digest of unread entries |

### Content processing

| Feature | Phase | Acceptance criteria |
|---|---|---|
| Sanitisation | P1 | All entry HTML sanitised on ingest against an allow-list; scripts, event handlers, and unsafe URLs removed |
| Full text | P3 | Readability extraction on demand per article and automatically per opted-in feed; original content kept |
| Image proxy | P1.6 | Optional per user; entry images served through the server (privacy, mixed content); responses cached; tracking pixels (1×1 images, known trackers) stripped |
| Lazy images | Later | Article images load lazily |
| Kept image cache | Missing requirements | Images of starred, published, noted, labelled, or shared entries stored permanently |
| Site rewrites | Later | Per-site content transforms (comics, Reddit/Imgur embeds) |

### Users and security

| Feature | Phase | Acceptance criteria |
|---|---|---|
| Multi-user | P1 | Admin creates, disables, deletes users and resets passwords; users manage only their own data |
| Admin bootstrap | P1 | First admin created from environment variables or CLI on an empty database, never under a well-known login; a generated password must be changed at first sign-in and expires after 7 days |
| Passwords | P1 | Argon2id hashes; change password in settings |
| Sessions | P1 | Cookie sessions for web with CSRF protection; list and revoke own sessions; bearer tokens for apps |
| Login rate limiting | P1 | Per-IP and per-account throttling with exponential delay |
| Preferences | P1 | Per-user preferences for all reading/updating options |
| TOTP 2FA | P1.6 | Enrol via QR code, recovery codes, required at every password login (web, desktop, mobile) once enabled; admin can reset |
| App passwords | P1.6 | Named, revocable passwords for TTRSS/Google Reader API clients; bypass TOTP; last-used time shown |

### APIs and clients

| Feature | Phase | Acceptance criteria |
|---|---|---|
| Native REST API | P1 | Versioned (`/api/v1`), OpenAPI document served; every web app action goes through it |
| Incremental sync | P1 | A sync endpoint returns categories, subscriptions, labels, and entries changed since a token, including deletions, without missing rows committed late |
| Web app | P1 | Vue SPA; installable PWA; works in current Chrome, Firefox, Safari |
| TTRSS-compatible API | P3 | TTRSS Android app and Newsboat can log in, browse, read, star, publish, label, and subscribe; TTRSS clients can share pages to the published feed |
| Google Reader API | P3 | ReadYou and Newsboat can log in, sync, and mark read/starred |
| App connection details | P3 | Settings show the server URL for TTRSS, Google Reader, and FreshRSS-type apps, the user name, and the suggested sync interval |
| Desktop app | P4 | Electron app for Windows (installer, zip) and Linux (AppImage, deb) with configurable server URL, secure token storage, native notifications for new entries, optional tray and launch at login, and automatic updates |
| Mobile app | P4 | Capacitor Android app with configurable server URL, secure token storage, share intent, and a prompt to install newer versions |
| Server profiles | Multiple Server Profiles | The desktop and Android apps keep several profiles (a server and a user), one active, each with its token in secure storage and its own offline store; the drawer, sign-in page, settings, and the desktop tray switch between them |
| macOS desktop app | Later | The desktop app, signed and notarised for macOS |

### Offline

| Feature | Phase | Acceptance criteria |
|---|---|---|
| Offline sync API | Offline Reading | Sync starts from a token for the present without walking history; edited content and full-text results reach sync; entries carry their read time and content version; content and proxied image URLs come in batches within the AWS response limit |
| Offline reading | Offline Reading | Web (opt-in per device), desktop, and Android apps keep unread and starred entries with text and images, and headlines read in the last 7 days, within a storage limit; images on Wi-Fi only on Android by default; the app starts, lists every stream, opens articles, and shows counters without a connection |
| Offline edits | Offline Reading | Article state, catch-up, notes, labels, tags, feed and label organisation, preferences, and themes change offline and are sent on reconnect; a newer change from another device is kept; note conflicts ask the reader |
| Offline search | Offline Reading | Searching without a connection finds stored articles by their words |
| Background sync | Offline Reading | Installed Chromium PWAs and the Android app sync while closed |
| Offline status | Offline Reading | The app shows when it is offline, how many changes are waiting, and when it last synced; settings show storage used and clear it |

### Migration

| Feature | Phase | Acceptance criteria |
|---|---|---|
| TTRSS import | P3 | Per `migration-ttrss.md`; reconciliation report shows matching per-user entry, label, and note counts |

### Operations

| Feature | Phase | Acceptance criteria |
|---|---|---|
| Docker deployment | P1 | Single image; `compose.yaml` starts Postgres, server, worker; healthchecks; migrations run before the server accepts traffic |
| Backups | P1 | Documented `pg_dump` sidecar and restore procedure |
| Health endpoint | P1 | `/healthz` reports DB and queue status |
| Runtime portability | P1 | Queue, scheduler, blob storage, and realtime are swappable adapters; no local-disk state outside blob storage |
| AWS deployment | P1.5 | Serverless compute: Lambda, SQS, EventBridge Scheduler, SPA on S3 + CloudFront; one small RDS PostgreSQL instance shared by the stages, each with its own database. One CDK pipeline (CodePipeline + CodeBuild) per stage runs `pnpm check`, builds the SPA, bundles the Lambdas, and deploys: branch `dev` → `dev`, `main` → `prod` |
| Operations page | Observability | Admins see, per user, last activity, requests by app, and articles read; per site, requests by outcome, busiest hour, and pauses; job runs, failures, and durations; on Docker and AWS |
| Audit log | Observability | Sign-ins, failed sign-ins, password, 2FA, app-password, user-management, and site-minimum events kept a year and browsable by admins |
| Alerts | Observability | A site rate limiting or failing, more requests to one site in an hour than the budget, failing or backed-up jobs, stalled fetching, and API server errors raise alerts on the Operations page, emailed when SMTP is configured (Docker) or an address subscribes to the stage's alert topic (AWS), and resolve on their own |
| Telemetry export | Observability | Traces, metrics, and logs export over OTLP when an endpoint is configured; the Docker setup offers Grafana with dashboards for the API, jobs, remote sites, and runtime. On AWS, traces go to X-Ray at a sampling rate set per stage, without CloudWatch metrics or dashboards |
| Cost budget | Observability | On AWS, one monthly budget over running the project, without its build pipelines (limit set in the infra config), emails its subscribers as spend nears or is forecast past it |
| Plugin API | Later | Third-party modules register content and lifecycle hooks |

## Non-functional requirements

| Area | Requirement |
|---|---|
| Scale | ~1,000 feeds and several million entries per instance; ~10 users |
| Remote hosts | One fetch per feed regardless of subscriber count; conditional GET; per host at most 2 concurrent requests, ≥ 1 s apart; publisher update hints, `Retry-After`, and HTTP 429 honoured host-wide; permanent redirects adopted; user-triggered refreshes rate-limited; downloads capped by size |
| Privacy | No calls to third parties beyond feed, icon, and article fetches; telemetry goes only to endpoints the operator configures, never carries credentials, secret keys, or article content, and carries feed URLs only when the operator turns on debug logging or the compatibility trace; no trace context is sent to remote hosts |
| Security | Sanitised content; strict CSP; SSRF protection on all server-side fetches (private ranges blocked unless allow-listed); secrets only via environment/secret store; OWASP ASVS L1 |
| Dependencies | High and critical advisories in production dependencies fail the pipeline (`pnpm audit`) and are fixed before the next deployment, at most 7 days after disclosure; moderate ones within 30 days; other dependency updates at least every 90 days |
| Accessibility | Fully keyboard operable; WCAG 2.2 AA contrast; screen-reader labels on controls; single-key shortcuts can be turned off; every drag action has a non-drag alternative |
| Internationalisation | All UI strings externalised; English shipped |
| Reliability | Worker restarts resume pending jobs; no entry loss on crash mid-ingest |
| Portability | One core runs under Docker Compose and AWS Lambda; only adapters and entrypoints differ |

## Non-goals

- Fever API
- Public self-registration
- Feed directory or recommendations
- OIDC, SAML, or reverse-proxy header authentication
- Google Play distribution
