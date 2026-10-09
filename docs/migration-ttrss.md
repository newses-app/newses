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
- Refuses a source whose `ttrss_version.schema_version` the importer has not been verified against.
- Reads the source in one read-only `REPEATABLE READ` transaction, so the import sees a single consistent snapshot.
- Batched and resumable: each batch commits on its own, and `import_map` records every imported source row, so re-running skips or updates rows already imported.
- Re-running after the first import applies changes made in TTRSS since then. Source state wins.
- Refuses to re-import into users who changed anything here since their last import finished (entry state, feeds, categories, labels), unless `--force`. Entries fetched here since then do not count as changes.
- Ends with a reconciliation report: per user, source vs imported counts of feeds, categories, entries, unread, starred, published, labels, notes, and filters, plus every skipped item and the reason, and notes (adopted users, temporary passwords, options not imported). Counts that do not add up are marked `!`, and the command then exits with status 1.

## Running the import

The source is read through a PostgreSQL URL. The official TTRSS compose stack does not publish its database port, so restore a dump (A) or join its network (B).

### A. Restore a copy (recommended)

1. Take a dump on the TTRSS host, or use the newest file in the `backups` volume:
   ```
   docker compose exec db sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > ttrss.dump
   ```
2. On the rss-reader host, restore it into a scratch database beside rss-reader's own:
   ```
   docker compose exec db sh -c 'createdb -U "$POSTGRES_USER" ttrss_import'
   docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d ttrss_import --no-owner' < ttrss.dump
   ```
   For a `.sql.gz` backup: `gunzip -c backup.sql.gz | docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d ttrss_import'`.
3. Import, with a dry run first:
   ```
   docker compose exec server sh -c 'rss-reader cli import-ttrss --source "postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@db/ttrss_import" --dry-run'
   docker compose exec server sh -c 'rss-reader cli import-ttrss --source "postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@db/ttrss_import"'
   ```
   `POSTGRES_USER` and `POSTGRES_PASSWORD` are rss-reader's, from `docker/.env`; the server container has them in `DATABASE_URL`, so `--source "${DATABASE_URL%/*}/ttrss_import"` works too.
4. Drop `ttrss_import` when finished: `docker compose exec db sh -c 'dropdb -U "$POSTGRES_USER" ttrss_import'`.

### B. Read the live database

When TTRSS runs on the same Docker host, connect rss-reader's server container to TTRSS's network for the import. Both stacks name their database service `db`, so address TTRSS's by its container name:

```
docker network connect <ttrss-project>_default rss-reader-server-1
docker compose exec server rss-reader cli import-ttrss \
  --source postgres://$TTRSS_DB_USER:$TTRSS_DB_PASS@<ttrss-project>-db-1/$TTRSS_DB_NAME --dry-run
docker network disconnect <ttrss-project>_default rss-reader-server-1
```

Use the values from the TTRSS `.env`. The import only reads, in one read-only transaction.

### AWS

Nothing runs in AWS for an import. The operator runs the rss-reader image on their own machine with Docker. The source is a dump restored into a local Postgres, as in A. The target is the stage's Aurora database, reached over its public TLS endpoint.

1. Restore the dump into a local rss-reader Docker stack's `db` (A, steps 1–2), or into any Postgres the container can reach.
2. Read the stage's connection details (stage `dev` or `prod`), with AWS credentials for account `123456789012` in `us-east-2`:
   ```
   STAGE=dev
   HOST=$(aws rds describe-db-clusters --db-cluster-identifier rss-reader-$STAGE --query 'DBClusters[0].Endpoint' --output text)
   DB_PASS=$(aws ssm get-parameter --name /rss-reader/$STAGE/db-password --with-decryption --query Parameter.Value --output text)
   APP_SECRET=$(aws ssm get-parameter --name /rss-reader/$STAGE/app-secret --with-decryption --query Parameter.Value --output text)
   curl -fsSo rds-ca.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
   ```
3. Import from the directory holding `docker/compose.yaml`, so the container joins the local stack's network and reaches its `db`:
   ```
   docker compose run --rm --no-deps -v "$PWD/rds-ca.pem:/rds-ca.pem:ro" \
     -e NODE_EXTRA_CA_CERTS=/rds-ca.pem -e APP_SECRET="$APP_SECRET" \
     -e DATABASE_URL="postgres://rss_reader:$(printf %s "$DB_PASS" | jq -sRr @uri)@$HOST:5432/rss_reader?sslmode=verify-full" \
     server cli import-ttrss --source "postgres://<local user>:<local password>@db/ttrss_import" --dry-run
   ```
   Run it again without `--dry-run` to import. The first connection waits up to 30 s while a paused database resumes.
4. Delete `rds-ca.pem`, and unset `DB_PASS` and `APP_SECRET`.

`APP_SECRET` must be the stage's, so the stage can read anything the import seals.

## Mapping

| TTRSS | Imported as | Notes |
|---|---|---|
| `ttrss_users` | `users` | `access_level` ≥ 10 → `admin`. A new user gets a temporary password, printed once in the report, which must be changed at first sign-in. A user here with the same login (any case) is adopted, keeping its password and role. Logins not allowed here are skipped. Users already imported are left unchanged on re-runs. TOTP and password hashes are not carried over |
| `ttrss_feed_categories` | `categories` | `parent_cat` → `parent_id`; `order_id` and `collapsed` kept. A title already used under the same parent merges into that category |
| `ttrss_feeds` | `feed_sources` + `subscriptions` | One feed source per normalised `feed_url` across all users, first fetched within 30 minutes of the import. Per user: title, category, `order_id`, `update_interval` (minutes, held to 15 min–7 days; `-1`, updates off, is noted and the feed is fetched), `purge_interval` (`-1` → never). Feeds with `auth_login` and invalid URLs are skipped; a user's second feed with the same normalised URL is skipped as a duplicate. Options with no equivalent (`hidden`, `cache_images`, `hide_images`, `always_display_enclosures`, `mark_unread_on_update`, `update_on_checksum_change`, `strip_images`, `rtl_content`, `cache_content`, `private`, `include_in_digest` off) are noted |
| `ttrss_entries` | `entries` | Title, link, author, content (sanitised as fetched items are), `updated` → published time, `date_entered` → fetch time, `lang`. TTRSS keeps a copy per user; copies with the same feed source, title, link, and content become one entry, whose GUID is `ttrss:` and that content hash. Times are read as UTC |
| `ttrss_user_entries` | `user_entries` | `unread`, `marked` → starred, `published`, `last_read` → read time; sort time is `updated`, at most now. Entries older than their subscription's purge age are skipped unless kept (starred, published, noted, labelled, or shared). Entries of skipped feeds are skipped; those of archived feeds (`orig_feed_id`) are kept without a subscription, under a feed source for the archived feed's URL. Copies of one article for one user merge: read if either was, starred or published if either was. `note` → note (at most 10,000 characters; merged copies' notes joined). `uuid` → share link: kept when it is a UUID, so legacy `public.php?op=share&key=…` links keep working; otherwise replaced by a stable new UUID and noted |
| `ttrss_archived_feeds` | — | Skipped and reported; their entries are imported as above |
| `ttrss_enclosures` | `enclosures` | URL, type, duration (seconds or `h:m:s`), dimensions |
| `ttrss_labels2` | `labels` | Caption (at most 100 characters; captions equal ignoring case merge); colours as `#rrggbb` from `#rgb` or `#rrggbb`, others replaced by the default and noted |
| `ttrss_user_labels2` | `entry_labels` | Joined via the label's owner to that user's `user_entries`; re-runs replace the imported entries' labels |
| `ttrss_tags` | `entry_tags` | `post_int_id` → `user_entries`; normalised (lower case, single spaces, no commas, at most 64 characters), at most 50 per entry; empty, duplicate, and excess tags skipped and counted; re-runs replace the imported entries' tags |
| `ttrss_filters2` | `filters` | `title`, `enabled`, `match_any_rule`, `inverse`, `order_id` |
| `ttrss_filters2_rules` | `filter_rules` | Type title/content/both/link/author/tag mapped; `feed_id`/`cat_id`/`match_on` → scope. PCRE patterns translated to JS regex; untranslatable patterns and date rules import with the filter disabled |
| `ttrss_filters2_actions` | `filter_actions` | delete, mark read, star, publish, tag, score, label, stop mapped; plugin actions skipped |
| `ttrss_user_prefs2` | `user_prefs` | Default profile only. `FRESH_ARTICLE_MAX_AGE`, `PURGE_OLD_DAYS`, `DEFAULT_UPDATE_INTERVAL`, `COMBINED_DISPLAY_MODE`, `CDM_AUTO_CATCHUP`, `CONFIRM_FEED_CATCHUP`, `HIDE_READ_FEEDS`, `_DEFAULT_VIEW_MODE`, `_DEFAULT_VIEW_ORDER_BY`; values with no equivalent are skipped, other preferences listed in the report |
| `ttrss_access_keys` | `access_keys` | The Published feed's key (`feed_id` `-2`) kept, so `/public/feeds/<key>` and the legacy `public.php?op=rss&id=-2&key=…` keep working; keys of other generated feeds are skipped |

Not imported:
- Sessions, app passwords, TOTP, and password hashes (users sign in with their temporary password, then set their own).
- Plugin data.
- Cached images and favicons (re-fetched).
- Error logs.
- Feed-browser cache.

The first fetch after an import takes over each imported entry whose link matches a fetched item, so it is not duplicated; the entry gets the feed's GUID and current content, and keeps every user's state.

## Checking an import

- The report has no `!` rows, and every skip and note is expected. Keep the printed temporary passwords for handing out, then delete any saved copy of the report.
- Each user signs in with their temporary password, sets their own, and finds their categories, feeds, and preferences as in TTRSS.
- Per-user counts match the source:
  ```
  SELECT u.login, count(f.id) AS feeds FROM ttrss_users u LEFT JOIN ttrss_feeds f ON f.owner_uid = u.id GROUP BY u.login;
  SELECT u.login, count(s.id) AS feeds FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id GROUP BY u.login;
  ```
- A second run reports the same counts and creates nothing.

## Cut-over

1. Run the new stack alongside TTRSS.
2. Import with `--dry-run`, review the report, then import.
3. Create app passwords. Point the existing TTRSS mobile app at the new server's `/api/` and verify reading, starring, and labels.
4. Stop the TTRSS updater, re-run the import to pick up final changes, then shut TTRSS down.
