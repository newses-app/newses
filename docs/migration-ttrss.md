# Migrating from TTRSS

The importer reads a TTRSS PostgreSQL database directly and writes into this instance. It never writes to the source; all reads run in a read-only transaction.

## CLI

```
cli import-ttrss --source <postgres-url> [--users alice,bob] [--since YYYY-MM-DD] [--dry-run] [--force]
```

| Option | Effect |
|---|---|
| `--source` | Connection URL of the TTRSS database (or a restored copy) |
| `--users` | Import only these TTRSS logins (default: all) |
| `--since` | Skip entries older than this date, except starred, published, labelled, noted, or shared ones |
| `--dry-run` | Read and map everything, write nothing, print the report |
| `--force` | Re-import into users who have used this instance since their last import |

Behaviour:
- Refuses a target whose applied migrations differ from the importer's build, and a source whose `ttrss_version.schema_version` the importer has not been verified against.
- Reads the source in one read-only `REPEATABLE READ` transaction, so the import sees a single consistent snapshot.
- Batched and resumable: each batch commits on its own, and `import_map` records every imported source row, so re-running skips or updates rows already imported.
- Re-running after the first import applies changes made in TTRSS since then. Source state wins.
- Refuses to re-import into users who changed anything here since their last import finished (entry state, feeds, categories, labels), unless `--force`. Entries fetched here since then do not count as changes, nor do the changes of runs that failed partway; a run cut short before recording its end (its process killed) needs `--force`.
- Ends with a reconciliation report: per user, source vs imported (and archived) counts of feeds, categories, entries, labels, notes, and filters, plus every skipped item and the reason, and notes (adopted users, temporary passwords, options not imported). Counts that do not add up are marked `!`, and the command then exits with status 1.

## Running the import

1. Dump the TTRSS database on its host, from the TTRSS compose directory, or use the newest file in its `backups` volume:
   ```
   docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > ttrss.dump
   ```
2. Copy the dump to a machine with this repository checked out and Docker running.
3. From the repository root, import into the running Docker stack in `docker/`, or into an AWS stage:
   ```
   scripts/import-ttrss.sh ttrss.dump
   scripts/import-ttrss.sh ttrss.dump --aws dev
   ```

| Option | Effect |
|---|---|
| `--aws dev\|prod` | Import into that stage's database, with the caller's AWS credentials (`AWS_PROFILE`), in the region of `infra/deploy.config.json` |
| `--users`, `--since`, `--force` | Passed to the CLI |
| `--dry-run` | Stop after the dry run |
| `--yes` | Import without asking |

The script:
- Restores the dump (`pg_dump -Fc`, `.sql`, or `.sql.gz`) into a temporary PostgreSQL container, removed when the script exits.
- Runs a dry run and prints its report, then asks before importing.
- Saves the import's report to `ttrss-import-<target>-<time>.txt` (mode 600) in the current directory and prints it with temporary passwords hidden. Hand the passwords out from the file before they expire, then delete it.
- On AWS, builds the image from the checkout and runs it locally against the database instance's public TLS endpoint, as the stage's role with its password and `APP_SECRET` from SSM; nothing runs in AWS. When the stage has the archive on (its `tick` function's `ARCHIVE_ENABLED`), the import writes it to the stage's blob bucket (the data stack's `BlobBucket` output) with the caller's credentials, which must last the whole import. The checkout must match the deployed version.

### Without a dump

When TTRSS runs on the same Docker host, connect Newses's server container to TTRSS's network for the import. Both stacks name their database service `db`, so address TTRSS's by its container name:

```
docker network connect <ttrss-project>_default newses-server-1
docker compose exec server newses cli import-ttrss \
  --source postgres://$TTRSS_DB_USER:$TTRSS_DB_PASS@<ttrss-project>-db-1/$TTRSS_DB_NAME --dry-run
docker network disconnect <ttrss-project>_default newses-server-1
```

Use the values from the TTRSS `.env`. The import only reads, in one read-only transaction.

## Mapping

| TTRSS | Imported as | Notes |
|---|---|---|
| `ttrss_users` | `users` | `access_level` ≥ 10 → `admin`. A new user gets a temporary password, printed once in the report with its expiry, which must be changed at first sign-in and expires after 7 days; an admin resets an expired one in Settings → Users. A user here with the same login (any case) is adopted, keeping its password and role. Logins not allowed here are skipped. Users already imported are left unchanged on re-runs. TOTP and password hashes are not carried over |
| `ttrss_feed_categories` | `categories` | `parent_cat` → `parent_id`; `order_id` and `collapsed` kept. A title already used under the same parent merges into that category |
| `ttrss_feeds` | `feed_sources` + `subscriptions` | One feed source per normalised `feed_url` across all users, first fetched within 30 minutes of the import. Per user: title, category, `order_id`, `update_interval` (minutes, held to 15 min–7 days; `-1`, updates off, → paused), `purge_interval` (`-1` → never). Feeds with `auth_login` and invalid URLs are skipped; a user's second feed with the same normalised URL is skipped as a duplicate. Re-runs keep an imported subscription on its feed source, whose URL may have moved here since (permanent redirect), so a `feed_url` changed in TTRSS is not applied. Options with no equivalent (`hidden`, `cache_images`, `hide_images`, `always_display_enclosures`, `mark_unread_on_update`, `update_on_checksum_change`, `strip_images`, `rtl_content`, `cache_content`, `private`, `include_in_digest` off) are noted |
| `ttrss_entries` | `entries` | Title, link, author, content (sanitised as fetched items are), `updated` → published time, `date_entered` → fetch time, `lang`. TTRSS keeps a copy per user; copies with the same feed source, title, link, and content become one entry, whose GUID is `ttrss:` and that content hash. Times are read as UTC |
| `ttrss_user_entries` | `user_entries` | `unread`, `marked` → starred, `published`, `score` (held to ±1,000,000), `last_read` → read time; sort time is `updated`, at most now. Entries older than their subscription's purge age, unless kept (starred, published, noted, labelled, or shared), go to the cold-storage archive (`ARCHIVE_ENABLED`) instead of the database, with a `ttrss:` GUID like imported entries; each article once, however many users had a copy, recorded in `import_map` (`ttrss_entries:archived`) so re-runs skip it, and counted as `archived` in the report. A dry run counts them without writing. With the archive off they are skipped, with a note. Entries of skipped feeds are skipped; those of archived feeds (`orig_feed_id`) are kept without a subscription, under a feed source for the archived feed's URL; kept entries with no feed at all (URLs shared to the published feed, starred entries of removed feeds) with an http(s) link, as that user's own page in the pages source, copies of one link merging; other entries with no feed are skipped. An entry a fetch here already brought in (same feed source and link) is joined rather than duplicated; re-runs update the entry imported before, even after a fetch has taken it over. Copies of one article for one user merge: read if either was, starred or published if either was, the score furthest from zero. `note` → note (at most 10,000 characters; merged copies' notes joined). `uuid` → share link: kept when it is a UUID, so legacy `public.php?op=share&key=…` links keep working; otherwise replaced by a stable new UUID and noted |
| `ttrss_archived_feeds` | — | Skipped and reported; their entries are imported as above |
| `ttrss_enclosures` | `enclosures` | URL, type, duration (seconds or `h:m:s`), dimensions |
| `ttrss_labels2` | `labels` | Caption (at most 100 characters; captions equal ignoring case merge); colours as `#rrggbb` from `#rgb` or `#rrggbb`, others replaced by the default and noted |
| `ttrss_user_labels2` | `entry_labels` | Joined via the label's owner to that user's `user_entries`; re-runs replace the imported entries' labels |
| `ttrss_tags` | `entry_tags` | `post_int_id` → `user_entries`; normalised (lower case, single spaces, no commas, at most 64 characters), at most 50 per entry; empty, duplicate, and excess tags skipped and counted; re-runs replace the imported entries' tags |
| `ttrss_filters2` | `filters` | `title`, `enabled`, `match_any_rule`, `inverse`, order by `order_id`. A filter with a rule or action that cannot be imported is imported disabled and noted; one left with no rule or no action is skipped. Re-runs replace imported filters |
| `ttrss_filters2_rules` | `filter_rules` | Types by `ttrss_filter_types.name`: title, content, both (title or content), link, author, tag; date rules have no equivalent. `match_on` (or the older `feed_id`, `cat_id`, `cat_filter`) → scope through the imported feeds and categories. PCRE patterns become RE2: `\Z` → `\z`, `\h` → `[ \t]`, `\R` → a line break; patterns RE2 still cannot compile (lookarounds, backreferences, atomic groups, possessive quantifiers) disable the filter |
| `ttrss_filters2_actions` | `filter_actions` | By `ttrss_filter_actions.name`: filter → delete, catchup → mark read, mark → star, publish, score, tag (comma-separated, normalised), label (by caption), stop; plugin and other actions have no equivalent |
| `ttrss_plugin_storage` | `subscriptions.full_text` | `af_readability`'s `enabled_feeds` and `append_feeds` (JSON or PHP-serialised) opt those feeds' subscriptions in to full text |
| `ttrss_user_prefs2` | `user_prefs` | Default profile only. `FRESH_ARTICLE_MAX_AGE`, `PURGE_OLD_DAYS`, `DEFAULT_UPDATE_INTERVAL`, `COMBINED_DISPLAY_MODE`, `CDM_AUTO_CATCHUP`, `CONFIRM_FEED_CATCHUP`, `HIDE_READ_FEEDS`, `_DEFAULT_VIEW_MODE`, `_DEFAULT_VIEW_ORDER_BY`; values with no equivalent are skipped, other preferences listed in the report |
| `ttrss_access_keys` | `access_keys` | The Published feed's key (`feed_id` `-2`) kept, so `/public/feeds/<key>` and the legacy `public.php?op=rss&id=-2&key=…` keep working; keys of other generated feeds are skipped |

Not imported:
- Sessions, app passwords, TOTP, and password hashes (users sign in with their temporary password, then set their own).
- Other plugin data.
- Cached images and favicons (re-fetched).
- Error logs.
- Feed-browser cache.

The first fetch after an import takes over each imported entry whose link matches a fetched item, so it is not duplicated; the entry gets the feed's GUID and current content, and keeps every user's state. Imported entries do not go through filters; imported filters act on entries fetched afterwards, or on existing ones when applied.

## Checking an import

- The report has no `!` rows, and every skip and note is expected.
- Each user signs in with their temporary password, sets their own, and finds their categories, feeds, and preferences as in TTRSS.
- Per-user counts match the source:
  ```
  SELECT u.login, count(f.id) AS feeds FROM ttrss_users u LEFT JOIN ttrss_feeds f ON f.owner_uid = u.id GROUP BY u.login;
  SELECT u.login, count(s.id) AS feeds FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id GROUP BY u.login;
  ```
- A second run reports the same counts and creates nothing.

## Cut-over

1. Run the new stack alongside TTRSS.
2. Run the import, reviewing the dry run before confirming.
3. Create app passwords. Point the existing TTRSS mobile app at the new server's `/api/` and verify reading, starring, and labels.
4. Stop the TTRSS updater, take a fresh dump and run the import again to pick up final changes, then shut TTRSS down.
