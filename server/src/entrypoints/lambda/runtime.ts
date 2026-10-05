import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SQSClient } from '@aws-sdk/client-sqs';
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

const secrets = new SecretsManagerClient({});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export async function readSecretString(secretId: string): Promise<string> {
  const secret = await secrets.send(
    new GetSecretValueCommand({ SecretId: requireValue(secretId) }),
  );
  return secret.SecretString ?? '';
}

/** A Secrets Manager secret holding a JSON object. */
export async function readSecretJson<T>(secretId: string): Promise<T> {
  return JSON.parse(await readSecretString(secretId)) as T;
}

function requireValue(secretId: string): string {
  if (!secretId) throw new Error('Secret ARN is not set');
  return secretId;
}

/** Builds DATABASE_URL from the RDS-generated secret named by DB_SECRET_ARN, unless it is set. */
async function resolveDatabaseUrl(): Promise<void> {
  if (process.env.DATABASE_URL) return;
  const { username, password, host, port, dbname } = await readSecretJson<{
    username: string;
    password: string;
    host: string;
    port: number;
    dbname?: string;
  }>(requireEnv('DB_SECRET_ARN'));
  const auth = `${encodeURIComponent(username)}:${encodeURIComponent(password)}`;
  process.env.DATABASE_URL = `postgres://${auth}@${host}:${String(port)}/${dbname ?? 'postgres'}?sslmode=verify-full`;
}

/**
 * Config, logger, pool, and the AWS feed adapters, created once per Lambda cold start.
 * Connecting may wait for a paused Aurora Serverless database to resume (about 15 s).
 */
export async function createLambdaRuntime(role: string) {
  await resolveDatabaseUrl();
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
