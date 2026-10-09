# Requirements

## Phases

| Phase | Scope | Exit criteria |
|---|---|---|
| P1 | MVP reader, self-hosted | Family members read daily feeds in the web app on a Docker deployment; OPML from TTRSS imported |
| P1.5 | AWS deployment | P1 build runs serverless on the AWS `dev` stage, deployed by the CDK pipeline from the `dev` branch |
| P1.6 | Security and accessibility | Image proxy, 2FA, and app passwords in daily use; Accessibility and Security non-functional requirements verified on the AWS `dev` stage |
| P2 | Power features | Labels, tags, notes, published feed, share links, reading preferences, and remappable shortcuts in daily use |
| P3 | TTRSS cut-over | All TTRSS users imported; filters, scoring, and full text in daily use; TTRSS and Google Reader clients work against the server; TTRSS retired |
| P4 | Native apps | Electron builds for Windows/macOS/Linux; Capacitor Android build installed on a device |
| Later | Backlog | Not scheduled |

## Features

### Feeds

| Feature | Phase | Acceptance criteria |
|---|---|---|
| Subscribe by URL | P1 | Accepts a feed URL or a web page URL; page URLs resolve via `<link rel="alternate">` autodiscovery, prompting when several feeds are found |
| Feed formats | P1 | RSS 0.9x/2.0, RSS 1.0/RDF, Atom 0.3/1.0, JSON Feed 1.x parse into the same entry model, including media/enclosure elements |
| Categories | P1 | Nested categories; create, rename, delete, reorder, move feeds by drag and drop |
| OPML import/export | P1 | Round-trips feeds and nested categories; imports a TTRSS OPML export without loss of feed URLs or category structure |
| Background updates | P1 | Per-feed interval (default global setting); conditional GET via ETag/Last-Modified; exponential backoff on failure; honours `Retry-After`/HTTP 429; manual "update now" |
| Feed errors | P1 | Last error and time shown per feed; "feeds with errors" view; feed auto-disables after a configurable number of consecutive failures |
| Favicons | P1 | Fetched per site, cached, shown in tree and headlines; fallback icon |
| Purge policy | P1 | Global and per-feed max age; never purges starred, published, noted, labelled, or shared entries |
| HTTP-auth feeds | Later | Basic auth credentials per subscription, encrypted at rest |
| Per-feed options | Later | Hide from "All articles", pause updates, always show images |
| Feed debugger | Later | Dry-run fetch shows raw response, parsed entries, and filter matches |
| Generated feeds | Later | Secret-key RSS feed for any feed, category, or label |
| WebSub | Later | Push subscriptions for hubs advertised by feeds |

### Reading

| Feature | Phase | Acceptance criteria |
|---|---|---|
| Special feeds | P1 | All articles, Fresh (configurable age), Starred, Published, Recently read, each with unread counts |
| Archived feed | Later | Starred/published/noted entries of unsubscribed feeds remain readable under "Archived" |
| Layouts | P1 | Three-pane (tree / headlines / article) and combined (expanded articles in list) modes; single-pane responsive layout below tablet width |
| View modes | P1 | All, unread only, adaptive (unread if any, else all) |
| Sorting | P1 | Newest first, oldest first, title |
| Score sorting | Later | Sort by score, then date |
| Read state | P1 | Mark read on open; optional mark read on scroll in combined mode; toggle unread |
| Catch-up | P1 | Mark feed/category/special feed read: all, or older than 1 day / 1 week / 2 weeks |
| Live counters | P1 | Unread counts update without reload within 5 s of ingest (SSE), falling back to polling when the stream is unavailable |
| Keyboard shortcuts | P1 | TTRSS default bindings (`j`/`k`, `n`/`p`, `s`, `u`, `o`, `/`, `f a`, `g a`, …); `?` shows a help overlay |
| Remappable shortcuts | P2 | Per-user keys or two-key sequences per action; settings record them, flag clashes, and reset to defaults; the help overlay shows the user's bindings |
| Themes | P1 | Light, dark, follow system |
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
| Full-text search | P1 | Searches title and content within current feed, category, or all; ranked results; results in < 1 s on 1M entries |
| Query syntax | Later | `title:`, `author:`, `note:`, `tag:`, `label:`, `unread:true/false`, `star:true/false`, `pub:true/false`, `@YYYY-MM-DD` and relative dates; negation with `-` |

### Sharing

| Feature | Phase | Acceptance criteria |
|---|---|---|
| Published feed | P2 | Per-user public RSS feed of published entries at a secret-key URL; key can be regenerated |
| Share link | P2 | Per-entry public read-only URL (unguessable UUID); can be revoked |
| Bookmarklets | Later | "Subscribe in reader" and "share to published" bookmarklets |
| Email | Later | Email an article; scheduled digest of unread entries |

### Content processing

| Feature | Phase | Acceptance criteria |
|---|---|---|
| Sanitisation | P1 | All entry HTML sanitised on ingest against an allow-list; scripts, event handlers, and unsafe URLs removed |
| Full text | P3 | Readability extraction on demand per article and automatically per opted-in feed; original content kept |
| Image proxy | P1.6 | Optional per user; entry images served through the server (privacy, mixed content); responses cached; tracking pixels (1×1 images, known trackers) stripped |
| Lazy images | Later | Article images load lazily |
| Starred image cache | Later | Images of starred entries stored permanently |
| Site rewrites | Later | Per-site content transforms (comics, Reddit/Imgur embeds) |

### Users and security

| Feature | Phase | Acceptance criteria |
|---|---|---|
| Multi-user | P1 | Admin creates, disables, deletes users and resets passwords; users manage only their own data |
| Admin bootstrap | P1 | First admin created from environment variables or CLI on an empty database; a generated password must be changed at first sign-in |
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
| TTRSS-compatible API | P3 | TTRSS Android app and Newsboat can log in, browse, read, star, publish, label, and subscribe |
| Google Reader API | P3 | ReadYou and Newsboat can log in, sync, and mark read/starred |
| App connection details | P3 | Settings show the server URL for TTRSS, Google Reader, and FreshRSS-type apps, the user name, and the suggested sync interval |
| Desktop app | P4 | Electron app with configurable server URL, secure token storage, native notifications for new entries |
| Mobile app | P4 | Capacitor Android app with configurable server URL, secure token storage, share-to-subscribe intent |
| Offline reading | Later | Local store of recent unread/starred entries; queued state changes replayed on reconnect |

### Migration

| Feature | Phase | Acceptance criteria |
|---|---|---|
| TTRSS import | P3 | Per `migration-ttrss.md`; reconciliation report shows matching per-user unread, starred, published, label, and note counts |

### Operations

| Feature | Phase | Acceptance criteria |
|---|---|---|
| Docker deployment | P1 | Single image; `compose.yaml` starts Postgres, server, worker; healthchecks; migrations run before the server accepts traffic |
| Backups | P1 | Documented `pg_dump` sidecar and restore procedure |
| Health endpoint | P1 | `/healthz` reports DB and queue status |
| Runtime portability | P1 | Queue, scheduler, blob storage, and realtime are swappable adapters; no local-disk state outside blob storage |
| AWS deployment | P1.5 | Serverless, with no running instances: Lambda, SQS, EventBridge Scheduler, Aurora Serverless v2 scaling to zero, SPA on S3 + CloudFront. One CDK pipeline (CodePipeline + CodeBuild) per stage runs `pnpm check`, builds the SPA, bundles the Lambdas, and deploys: branch `dev` → `dev`, `main` → `prod` |
| Admin log and metrics | Later | System log view; fetch statistics; Prometheus endpoint |
| Plugin API | Later | Third-party modules register content and lifecycle hooks |

## Non-functional requirements

| Area | Requirement |
|---|---|
| Scale | ~1,000 feeds and several million entries per instance; ~10 users |
| Performance | Headline list p95 < 200 ms; article open p95 < 150 ms; ingest of a 100-entry feed < 2 s |
| Remote hosts | One fetch per feed regardless of subscriber count; conditional GET; per host at most 2 concurrent requests, ≥ 1 s apart; publisher update hints, `Retry-After`, and HTTP 429 honoured host-wide; permanent redirects adopted; user-triggered refreshes rate-limited; downloads capped by size |
| Privacy | No telemetry or third-party calls beyond feed, icon, and article fetches |
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
