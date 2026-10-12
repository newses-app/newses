import { AthenaClient } from '@aws-sdk/client-athena';
import { S3Client } from '@aws-sdk/client-s3';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import type { PgBoss } from 'pg-boss';
import { ARCHIVE_TABLE } from '../adapters/archive-format.ts';
import { AthenaArchiveReader, AthenaClientRunner } from '../adapters/athena-archive-reader.ts';
import { DuckDbArchiveReader } from '../adapters/duckdb-archive-reader.ts';
import { InstrumentedFetcher } from '../adapters/instrumented-fetcher.ts';
import { LocalBlobStore } from '../adapters/local-blob-store.ts';
import { ParquetArchiveWriter } from '../adapters/parquet-archive-writer.ts';
import { S3BlobStore } from '../adapters/s3-blob-store.ts';
import { SmtpNotifier } from '../adapters/smtp-notifier.ts';
import { PgBossJobQueue } from '../adapters/pg-boss-job-queue.ts';
import { PgNotifyRealtime } from '../adapters/pg-notify-realtime.ts';
import type { AppConfig } from '../core/config.ts';
import { deriveKeys } from '../core/crypto.ts';
import { HttpFetcher, userAgentFor } from '../core/feeds/http.ts';
import type { FeedDeps } from '../core/feeds/index.ts';
import { JOB_DEFINITIONS, type Jobs } from '../core/jobs.ts';
import type { OpsRecorder } from '../core/ops/recorder.ts';
import type { ArchiveReader, ArchiveWriter, BlobStore, Logger, Notifier } from '../core/ports.ts';
import type { Db } from '../db/client.ts';

/** Self-hosted adapters for the feed services, shared by the server and worker. */
export function createFeedDeps(args: {
  config: AppConfig;
  db: Db;
  boss: PgBoss;
  realtime: PgNotifyRealtime;
  logger: Logger;
  ops: OpsRecorder;
}): FeedDeps & { fetcher: InstrumentedFetcher } {
  const blobs = createBlobStore(args.config);
  return {
    db: args.db,
    fetcher: createFetcher(args.config, args.ops),
    queue: new PgBossJobQueue<Jobs>(args.boss, JOB_DEFINITIONS),
    realtime: args.realtime,
    blobs,
    archive: createArchiveWriter(args.config, blobs),
    settings: args.config.feeds,
    logger: args.logger,
    keys: deriveKeys(args.config.appSecret),
  };
}

/** pg-boss tracing: a job's trace continues from the request or task that queued it. */
export const PG_BOSS_TELEMETRY = {
  propagateContext: true,
  // Trace ids only; no baggage is stored on jobs.
  propagator: new W3CTraceContextPropagator(),
};

/** The fetcher for remote hosts, counting every request in the ops statistics. */
export function createFetcher(config: AppConfig, ops: OpsRecorder): InstrumentedFetcher {
  return new InstrumentedFetcher(
    new HttpFetcher({
      allowPrivateNetworks: config.fetchAllowPrivateNetworks,
      userAgent: userAgentFor(config.version),
    }),
    ops,
  );
}

/** Alert emails when SMTP is configured; otherwise alerts stay on the Operations page. */
export function createNotifier(config: AppConfig): Notifier | undefined {
  const email = config.ops.alertEmail;
  return email ? new SmtpNotifier({ ...email, publicUrl: config.publicUrl }) : undefined;
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
