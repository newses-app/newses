import type { PgBoss } from 'pg-boss';
import { LocalBlobStore } from '../adapters/local-blob-store.ts';
import { S3BlobStore } from '../adapters/s3-blob-store.ts';
import { PgBossJobQueue } from '../adapters/pg-boss-job-queue.ts';
import { PgNotifyRealtime } from '../adapters/pg-notify-realtime.ts';
import type { AppConfig } from '../core/config.ts';
import { HttpFetcher } from '../core/feeds/http.ts';
import type { FeedDeps } from '../core/feeds/index.ts';
import { JOB_DEFINITIONS, type Jobs } from '../core/jobs.ts';
import type { BlobStore, Logger } from '../core/ports.ts';
import type { Db } from '../db/client.ts';

/** Self-hosted adapters for the feed services, shared by the server and worker. */
export function createFeedDeps(args: {
  config: AppConfig;
  db: Db;
  boss: PgBoss;
  realtime: PgNotifyRealtime;
  logger: Logger;
}): FeedDeps & { fetcher: HttpFetcher } {
  return {
    db: args.db,
    fetcher: new HttpFetcher({ allowPrivateNetworks: args.config.fetchAllowPrivateNetworks }),
    queue: new PgBossJobQueue<Jobs>(args.boss, JOB_DEFINITIONS),
    realtime: args.realtime,
    blobs: createBlobStore(args.config),
    settings: args.config.feeds,
    logger: args.logger,
  };
}

export function createBlobStore(config: AppConfig): BlobStore {
  return config.blobBucket
    ? new S3BlobStore(config.blobBucket)
    : new LocalBlobStore(config.blobDir);
}
