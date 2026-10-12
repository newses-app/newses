import { AthenaClient } from '@aws-sdk/client-athena';
import { S3Client } from '@aws-sdk/client-s3';
import type { PgBoss } from 'pg-boss';
import { ARCHIVE_TABLE } from '../adapters/archive-format.ts';
import { AthenaArchiveReader, AthenaClientRunner } from '../adapters/athena-archive-reader.ts';
import { DuckDbArchiveReader } from '../adapters/duckdb-archive-reader.ts';
import { LocalBlobStore } from '../adapters/local-blob-store.ts';
import { ParquetArchiveWriter } from '../adapters/parquet-archive-writer.ts';
import { S3BlobStore } from '../adapters/s3-blob-store.ts';
import { PgBossJobQueue } from '../adapters/pg-boss-job-queue.ts';
import { PgNotifyRealtime } from '../adapters/pg-notify-realtime.ts';
import type { AppConfig } from '../core/config.ts';
import { deriveKeys } from '../core/crypto.ts';
import { HttpFetcher } from '../core/feeds/http.ts';
import type { FeedDeps } from '../core/feeds/index.ts';
import { JOB_DEFINITIONS, type Jobs } from '../core/jobs.ts';
import type { ArchiveReader, ArchiveWriter, BlobStore, Logger } from '../core/ports.ts';
import type { Db } from '../db/client.ts';

/** Self-hosted adapters for the feed services, shared by the server and worker. */
export function createFeedDeps(args: {
  config: AppConfig;
  db: Db;
  boss: PgBoss;
  realtime: PgNotifyRealtime;
  logger: Logger;
}): FeedDeps & { fetcher: HttpFetcher } {
  const blobs = createBlobStore(args.config);
  return {
    db: args.db,
    fetcher: new HttpFetcher({ allowPrivateNetworks: args.config.fetchAllowPrivateNetworks }),
    queue: new PgBossJobQueue<Jobs>(args.boss, JOB_DEFINITIONS),
    realtime: args.realtime,
    blobs,
    archive: createArchiveWriter(args.config, blobs),
    settings: args.config.feeds,
    logger: args.logger,
    keys: deriveKeys(args.config.appSecret),
  };
}

export function createBlobStore(config: AppConfig): BlobStore {
  return config.blobBucket
    ? new S3BlobStore(config.blobBucket)
    : new LocalBlobStore(config.blobDir);
}

export function createArchiveWriter(config: AppConfig, blobs: BlobStore): ArchiveWriter | null {
  return config.archiveEnabled ? new ParquetArchiveWriter(blobs) : null;
}

/**
 * Reads the archive with Athena when the blobs are in S3 and Athena is configured (AWS), with
 * DuckDB when they are on local disk (Docker); otherwise the archive is written but not read.
 */
export function createArchiveReader(config: AppConfig, blobs: BlobStore): ArchiveReader | null {
  if (!config.archiveEnabled) return null;
  if (!config.blobBucket) return new DuckDbArchiveReader(config.blobDir, blobs);
  if (!config.archiveAthena) return null;
  return new AthenaArchiveReader(
    new AthenaClientRunner(new AthenaClient({}), config.archiveAthena),
    {
      s3: new S3Client({}),
      bucket: config.blobBucket,
      table: ARCHIVE_TABLE,
    },
  );
}
