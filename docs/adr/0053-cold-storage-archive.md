# 0053. Cold-storage archive

- Status: Accepted
- Date: 2026-10-11

## Context
Purge deletes articles for good: unreferenced entries after a grace period, and every entry of an abandoned feed source. The TTRSS importer drops articles older than their purge age, which is most of some users' history. Keeping them in Postgres would grow the database without bound. Docker needs a self-contained solution; on AWS nothing may run all the time, and native code in Lambda bundles costs size and cold starts.

## Decision
- What purge would delete, and what the importer would drop, goes to a cold-storage archive of Parquet files under the blob root: `archive/entries/month=YYYY-MM/<uuid>.parquet`, one month of `sort_at` per folder, rows sorted by feed URL and time. Files are only added; readers collapse duplicates.
- One writer for both deployments: `hyparquet-writer` (pure JavaScript) through `BlobStore`. Purge writes a batch, then deletes it, re-checking its conditions, so a crash leaves duplicates, never loss.
- Reads use the engine native to each deployment: DuckDB in-process on Docker; Athena over a Glue table with partition projection on AWS. The file layout is one definition in `server`, which the writer and the Glue table share.
- On by default; `ARCHIVE_ENABLED=false` turns it off. On AWS it is a stage setting.

## Consequences
- The archive is not in `pg_dump` and cannot be re-fetched; self-hosters back up the `blobs` volume.
- Lambda bundles carry no native code for the archive; DuckDB ships only in the Docker image.
- Two query engines over one format, so reader SQL stays in their common subset.
- Rows from purge keep their entry id; imported rows are identified by feed URL and GUID.
