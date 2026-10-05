import { SQSClient } from '@aws-sdk/client-sqs';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import pino from 'pino';
import { loadConfig } from '../../adapters/env-config.ts';
import { NoopRealtime } from '../../adapters/noop-realtime.ts';
import { SqsJobQueue } from '../../adapters/sqs-job-queue.ts';
import { HttpFetcher } from '../../core/feeds/http.ts';
import type { FeedDeps } from '../../core/feeds/index.ts';
import type { Jobs } from '../../core/jobs.ts';
import { createDb } from '../../db/client.ts';
import { createBlobStore } from '../feed-deps.ts';
import { createPool } from '../runtime.ts';

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

/**
 * Config, logger, pool, and the AWS feed adapters, created once per Lambda cold start.
 * Connecting may wait for a paused Aurora Serverless database to resume (about 15 s).
 */
export async function createLambdaRuntime(role: string) {
  await resolveDatabaseUrl();
  await resolveAdminPassword();
  const config = loadConfig();
  const logger = pino({ level: config.logLevel, base: { role } });
  const pool = createPool(config, logger, {
    api: role === 'api',
    max: 2,
    connectionTimeoutMillis: 30_000,
  });
  const db = createDb(pool);
  const feedDeps: FeedDeps = {
    db,
    fetcher: new HttpFetcher({ allowPrivateNetworks: config.fetchAllowPrivateNetworks }),
    queue: new SqsJobQueue<Jobs>(
      {
        'feed.fetch': requireEnv('FEED_FETCH_QUEUE_URL'),
        'feed.favicon': requireEnv('FEED_FAVICON_QUEUE_URL'),
      },
      new SQSClient({}),
    ),
    realtime: new NoopRealtime(),
    blobs: createBlobStore(config),
    settings: config.feeds,
    logger,
  };
  return { config, logger, pool, db, feedDeps };
}

/** SQS batch handler: failed messages are reported back for redelivery, the rest are deleted. */
export function sqsHandler(
  logger: pino.Logger,
  // `never` accepts handlers typed for their job's payload; bodies are trusted queue messages.
  handle: (body: never) => Promise<void>,
): (event: SQSEvent) => Promise<SQSBatchResponse> {
  return async (event) => {
    const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
    for (const record of event.Records) {
      try {
        await handle(JSON.parse(record.body) as never);
      } catch (err) {
        logger.error({ err, messageId: record.messageId }, 'Job failed');
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  };
}
