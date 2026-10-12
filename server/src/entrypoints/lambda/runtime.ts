import { SQSClient } from '@aws-sdk/client-sqs';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import type pg from 'pg';
import { loadConfig } from '../../adapters/env-config.ts';
import { NoopRealtime } from '../../adapters/noop-realtime.ts';
import { SqsJobQueue } from '../../adapters/sqs-job-queue.ts';
import { deriveKeys } from '../../core/crypto.ts';
import type { FeedDeps } from '../../core/feeds/index.ts';
import type { Jobs } from '../../core/jobs.ts';
import { createOpsServices, type OpsServices } from '../../core/ops/index.ts';
import type { Logger } from '../../core/ports.ts';
import { createDb } from '../../db/client.ts';
import { extractTraceContext } from '../../telemetry/index.ts';
import {
  createArchiveReader,
  createArchiveWriter,
  createBlobStore,
  createFetcher,
} from '../feed-deps.ts';
import { createLogger, createPool } from '../runtime.ts';
import { trackRun } from '../tracking.ts';

const ssm = new SSMClient({});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** The decrypted value of the SSM parameter named by the environment variable `envName`. */
export async function readParameter(envName: string): Promise<string> {
  const { Parameter } = await ssm.send(
    new GetParameterCommand({ Name: requireEnv(envName), WithDecryption: true }),
  );
  return Parameter?.Value ?? '';
}

/** Builds DATABASE_URL from the DB_* variables and password parameter, unless it is set. */
async function resolveDatabaseUrl(): Promise<void> {
  if (process.env.DATABASE_URL) return;
  const password = await readParameter('DB_PASSWORD_PARAMETER');
  const auth = `${encodeURIComponent(requireEnv('DB_USER'))}:${encodeURIComponent(password)}`;
  const address = `${requireEnv('DB_HOST')}:${requireEnv('DB_PORT')}/${requireEnv('DB_NAME')}`;
  process.env.DATABASE_URL = `postgres://${auth}@${address}?sslmode=verify-full`;
}

/** Sets ADMIN_PASSWORD from the parameter named by ADMIN_PASSWORD_PARAMETER, when that is set. */
async function resolveAdminPassword(): Promise<void> {
  if (!process.env.ADMIN_PASSWORD_PARAMETER || process.env.ADMIN_PASSWORD) return;
  process.env.ADMIN_PASSWORD = await readParameter('ADMIN_PASSWORD_PARAMETER');
}

/** Sets APP_SECRET from the parameter named by APP_SECRET_PARAMETER, unless it is set. */
async function resolveAppSecret(): Promise<void> {
  if (process.env.APP_SECRET) return;
  process.env.APP_SECRET = await readParameter('APP_SECRET_PARAMETER');
}

/**
 * Config, logger, pool, and the AWS feed adapters, created once per Lambda cold start.
 * Connecting may wait for a paused Aurora Serverless database to resume (about 15 s).
 */
export async function createLambdaRuntime(role: string) {
  await resolveDatabaseUrl();
  await resolveAdminPassword();
  await resolveAppSecret();
  const config = loadConfig();
  const logger = createLogger(config, role);
  const pool = createPool(config, logger, {
    api: role === 'api',
    max: 2,
    connectionTimeoutMillis: 30_000,
  });
  const db = createDb(pool);
  const blobs = createBlobStore(config);
  // Alerts stay on the Operations page; AWS notification is not set up.
  const ops = createOpsServices({ db, logger, settings: config.ops });
  const feedDeps: FeedDeps = {
    db,
    fetcher: createFetcher(config, ops.recorder),
    queue: new SqsJobQueue<Jobs>(
      {
        'feed.fetch': requireEnv('FEED_FETCH_QUEUE_URL'),
        'feed.favicon': requireEnv('FEED_FAVICON_QUEUE_URL'),
        'entry.extract': requireEnv('ENTRY_EXTRACT_QUEUE_URL'),
      },
      new SQSClient({}),
    ),
    realtime: new NoopRealtime(),
    blobs,
    archive: createArchiveWriter(config, blobs),
    settings: config.feeds,
    keys: deriveKeys(config.appSecret),
    logger,
  };
  return {
    config,
    logger,
    pool,
    db,
    feedDeps,
    ops,
    archive: createArchiveReader(config, blobs),
  };
}

/**
 * Whether the pool handed out a connection since the last `reset`, so writes can wait for an
 * invocation that has the database awake anyway.
 */
export function trackPoolUse(pool: pg.Pool): { used(): boolean; reset(): void } {
  let used = false;
  pool.on('acquire', () => {
    used = true;
  });
  return {
    used: () => used,
    reset: () => {
      used = false;
    },
  };
}

/**
 * SQS batch handler: failed messages are reported back for redelivery, the rest are deleted. Each
 * message's job continues the trace that queued it, and the ops statistics are written before the
 * invocation ends.
 */
export function sqsHandler(
  runtime: { logger: Logger; ops: OpsServices },
  job: keyof Jobs,
  // `never` accepts handlers typed for their job's payload; bodies are trusted queue messages.
  handle: (body: never) => Promise<void>,
): (event: SQSEvent) => Promise<SQSBatchResponse> {
  const { logger, ops } = runtime;
  return async (event) => {
    const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
    for (const record of event.Records) {
      const traceparent = record.messageAttributes.traceparent?.stringValue;
      try {
        await trackRun(ops.recorder, job, () => handle(JSON.parse(record.body) as never), {
          parent: extractTraceContext(traceparent ? { traceparent } : undefined),
        });
      } catch (err) {
        logger.error({ err, messageId: record.messageId }, 'Job failed');
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    await ops.recorder.flush();
    return { batchItemFailures };
  };
}
