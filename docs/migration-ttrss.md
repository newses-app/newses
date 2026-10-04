# Migrating from TTRSS

The importer reads a TTRSS PostgreSQL database directly and writes into this instance. It never writes to the source; all reads run in a read-only transaction.

## CLI

```
cli import-ttrss --source <postgres-url> [--users alice,bob] [--since YYYY-MM-DD] [--dry-run]
```

| Option | Effect |
|---|---|
| `--source` | Connection URL of the TTRSS database (or a restored copy) |
| `--users` | Import only these TTRSS logins (default: all) |
| `--since` | Skip entries older than this date, except starred, published, labelled, or noted ones |
| `--dry-run` | Read and map everything, write nothing, print the report |

Behaviour:
- Verifies `ttrss_version.schema_version` is within the supported range before reading.
- Batched and resumable: `import_map` records every imported source row, so re-running skips or updates rows already imported.
- Re-running after the first import applies changes made in TTRSS since then. Source state wins.
- Ends with a reconciliation report: per user, source vs imported counts of feeds, categories, entries, unread, starred, published, labels, notes, and filters, plus every skipped item and the reason.

## Getting access to the source database

The official TTRSS compose stack does not publish the database port. Use one of:

### A. Restore a copy (recommended)

1. Take a dump on the TTRSS host, or use the newest file in the `backups` volume:
   ```
   docker compose exec db sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > ttrss.dump
   ```
2. Copy `ttrss.dump` to the new host and restore it into a scratch database:
   ```
   docker compose exec db createdb -U "$POSTGRES_USER" ttrss_import
   docker compose exec -T db pg_restore -U "$POSTGRES_USER" -d ttrss_import --no-owner < ttrss.dump
   ```
   For a `.sql.gz` backup: `gunzip -c backup.sql.gz | docker compose exec -T db psql -U "$POSTGRES_USER" -d ttrss_import`.
3. Import:
   ```
   docker compose run --rm cli import-ttrss --source postgres://USER:PASS@db/ttrss_import --dry-run
   docker compose run --rm cli import-ttrss --source postgres://USER:PASS@db/ttrss_import
   ```
4. Drop `ttrss_import` when finished.

### B. Read the live database

Run the importer on the TTRSS compose network, using the values from the TTRSS `.env`:

```
docker run --rm --network <ttrss-project>_default -e DATABASE_URL=… <image> cli import-ttrss \
  --source postgres://$TTRSS_DB_USER:$TTRSS_DB_PASS@db/$TTRSS_DB_NAME
```

### AWS

1. Upload the dump to the blob bucket.
2. Run the `cli` task definition as a one-off ECS task. It restores the dump into a scratch database on RDS, runs the import, and drops the scratch database.

## Mapping

| TTRSS | Imported as | Notes |
|---|---|---|
| `ttrss_users` | `users` | `access_level` ≥ 10 → `admin`. Password hashes in supported legacy formats are verified on first login and rehashed to Argon2id; other users get an admin-set temporary password. TOTP is not carried over |
| `ttrss_feed_categories` | `categories` | `parent_cat` → `parent_id`; `order_id` kept |
| `ttrss_feeds` | `feed_sources` + `subscriptions` | One feed source per normalised `feed_url` across all users; per-user title, category, `update_interval`, `purge_interval`, `hide_images`/`cache_images` options, `auth_login`/`auth_pass` (re-encrypted) |
| `ttrss_entries` | `entries` | Title, link, author, content, `content_hash`, `updated`/`date_entered`, `lang`. TTRSS GUIDs are owner-scoped hashes, so entries are deduplicated across users by (feed source, link, content hash) |
| `ttrss_user_entries` | `user_entries` | `unread`, `marked` → starred, `published`, `score`, `note`, `last_read`, `uuid` → share UUID; `orig_feed_id` → archived feed |
| `ttrss_archived_feeds` | `archived_feeds` | Title, URLs |
| `ttrss_enclosures` | `enclosures` | URL, type, duration, dimensions |
| `ttrss_labels2` | `labels` | Caption, `fg_color`, `bg_color` |
| `ttrss_user_labels2` | `entry_labels` | Joined via the label's owner to that user's `user_entries` |
| `ttrss_tags` | `tags` | `post_int_id` → `user_entries` |
| `ttrss_filters2` | `filters` | `title`, `enabled`, `match_any_rule`, `inverse`, `order_id` |
| `ttrss_filters2_rules` | `filter_rules` | Type title/content/both/link/author/tag mapped; `feed_id`/`cat_id`/`match_on` → scope. PCRE patterns translated to JS regex; untranslatable patterns and date rules import with the filter disabled |
| `ttrss_filters2_actions` | `filter_actions` | delete, mark read, star, publish, tag, score, label, stop mapped; plugin actions skipped |
| `ttrss_user_prefs2` | `user_prefs` | Prefs with an equivalent setting (update interval, purge age, fresh age, combined mode, auto catch-up, timezone, sort, view mode); others listed in the report |
| `ttrss_access_keys` | `access_keys` | Published-feed key kept, so existing public feed URLs stay valid. The legacy `public.php?op=rss&id=-2&key=…` URL redirects |

Not imported:
- Sessions and app passwords (re-create them).
- Plugin data.
- Cached images and favicons (re-fetched).
- Error logs.
- Feed-browser cache.

Imported entries are matched to newly fetched items by link, so the first fetch after import does not duplicate them.

## Cut-over

1. Run the new stack alongside TTRSS.
2. Import with `--dry-run`, review the report, then import.
3. Create app passwords. Point the existing TTRSS mobile app at the new server's `/api/` and verify reading, starring, and labels.
4. Stop the TTRSS updater, re-run the import to pick up final changes, then shut TTRSS down.
