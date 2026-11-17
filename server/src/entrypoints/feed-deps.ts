import { W3CTraceContextPropagator } from '@opentelemetry/core';
import type { PgBoss } from 'pg-boss';
import { DuckDbArchiveReader } from '../adapters/duckdb-archive-reader.ts';
import { InstrumentedFetcher } from '../adapters/instrumented-fetcher.ts';
import { LocalBlobStore } from '../adapters/local-blob-store.ts';
import { NodemailerMailer, smtpTransport } from '../adapters/mailer.ts';
import { ParquetArchiveWriter } from '../adapters/parquet-archive-writer.ts';
import { S3BlobStore } from '../adapters/s3-blob-store.ts';
import { SmtpNotifier } from '../adapters/smtp-notifier.ts';
import { WebPushSender } from '../adapters/web-push-sender.ts';
import { PgBossJobQueue } from '../adapters/pg-boss-job-queue.ts';
import { PgNotifyRealtime } from '../adapters/pg-notify-realtime.ts';
import type { AppConfig } from '../core/config.ts';
import { deriveKeys, type Keys } from '../core/crypto.ts';
import { HttpFetcher, userAgentFor } from '../core/feeds/http.ts';
import type { FeedDeps } from '../core/feeds/index.ts';
import { JOB_DEFINITIONS, type Jobs } from '../core/jobs.ts';
import type { OpsRecorder } from '../core/ops/recorder.ts';
import type {
  ArchiveReader,
  ArchiveWriter,
  BlobStore,
  Logger,
  Mailer,
  Notifier,
} from '../core/ports.ts';
import type { Db } from '../db/client.ts';
import { createPluginHost } from '../plugins/index.ts';
import type { PluginRegistry } from '../plugins/registry.ts';
import type { PoliteFetcher } from '../core/feeds/polite-fetcher.ts';

/** Self-hosted adapters for the feed services, shared by the server and worker. */
export function createFeedDeps(args: {
  config: AppConfig;
  db: Db;
  boss: PgBoss;
  realtime: PgNotifyRealtime;
  logger: Logger;
  ops: OpsRecorder;
}): FeedDeps & { fetcher: InstrumentedFetcher; push: WebPushSender } {
  const blobs = createBlobStore(args.config);
  const keys = deriveKeys(args.config.appSecret);
  return {
    db: args.db,
    fetcher: createFetcher(args.config, args.ops),
    queue: new PgBossJobQueue<Jobs>(args.boss, JOB_DEFINITIONS),
    realtime: args.realtime,
    push: createPushSender(args.config, keys, args.logger),
    mailer: createMailer(args.config),
    blobs,
    archive: createArchiveWriter(args.config, blobs),
    settings: args.config.feeds,
    logger: args.logger,
    keys,
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

/**
 * Web Push to the push services devices subscribed with, signed with the VAPID key from the app
 * secret. Push services may write to the sender's contact: the public URL when it is https (as
 * RFC 8292 asks), else the project site.
 */
export function createPushSender(config: AppConfig, keys: Keys, logger: Logger): WebPushSender {
  return new WebPushSender({
    seed: keys.vapid,
    subject: config.publicUrl?.startsWith('https:') ? config.publicUrl : 'https://newses.app',
    allowPrivateNetworks: config.fetchAllowPrivateNetworks,
    trustedHosts: config.push.trustedHosts,
    tokens: config.push.tokens,
    logger,
  });
}

/** Alert emails when SMTP is configured; otherwise alerts stay on the Operations page. */
export function createNotifier(config: AppConfig): Notifier | undefined {
  const email = config.ops.alertEmail;
  return email ? new SmtpNotifier({ ...email, publicUrl: config.publicUrl }) : undefined;
}

/** User mail over SMTP when `SMTP_URL` is set; SES sending is wired in `lambda/runtime.ts`. */
export function createMailer(config: AppConfig): Mailer | null {
  const mail = config.mail;
  if (!mail) return null;
  if (mail.transport.kind !== 'smtp') {
    throw new Error(
      'MAIL_SES_CONFIGURATION_SET sends through SES, which only the AWS functions do',
    );
  }
  return new NodemailerMailer({
    from: mail.from,
    createTransport: smtpTransport(mail.transport.url),
  });
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
 * Reads the archive with DuckDB when the blobs are on local disk; with `BLOB_BUCKET` it is written
 * but not read (the Lambdas read it with Athena, in `lambda/runtime.ts`).
 */
export function createArchiveReader(config: AppConfig, blobs: BlobStore): ArchiveReader | null {
  return config.archiveEnabled && !config.blobBucket
    ? new DuckDbArchiveReader(config.blobDir, blobs)
    : null;
}

/** The plugins of this process: settings, storage, and event deliveries, fetching through `polite`. */
export function createProcessPlugins(args: {
  config: AppConfig;
  registry: PluginRegistry;
  db: Db;
  keys: Keys;
  logger: Logger;
  ops: OpsRecorder;
  polite: Pick<PoliteFetcher, 'request'>;
}) {
  return createPluginHost({
    registry: args.registry,
    db: args.db,
    keys: args.keys,
    logger: args.logger,
    ops: args.ops,
    polite: args.polite,
    allowPrivateNetworks: args.config.fetchAllowPrivateNetworks,
    userAgent: userAgentFor(args.config.version),
    publicUrl: args.config.publicUrl,
  });
}
