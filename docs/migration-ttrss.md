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
| `--since` | Skip entries older than this date, except starred, published, labelled, or noted ones |
| `--dry-run` | Read and map everything, write nothing, print the report |
| `--force` | Re-import into users who have used this instance since their last import |

Behaviour:
- Refuses a source whose `ttrss_version.schema_version` the importer has not been verified against.
- Reads the source in one read-only `REPEATABLE READ` transaction, so the import sees a single consistent snapshot.
- Batched and resumable: each batch commits on its own, and `import_map` records every imported source row, so re-running skips or updates rows already imported.
- Re-running after the first import applies changes made in TTRSS since then. Source state wins.
- Refuses to re-import into users who changed anything here since their last import finished (entry state, feeds, categories, labels), unless `--force`. Entries fetched here since then do not count as changes.
- Ends with a reconciliation report: per user, source vs imported counts of feeds, categories, entries, unread, starred, published, labels, notes, and filters, plus every skipped item and the reason. Counts that do not add up are marked `!`, and the command then exits with status 1.

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
