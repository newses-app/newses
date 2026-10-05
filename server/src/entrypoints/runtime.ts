import { monitorEventLoopDelay } from 'node:perf_hooks';
import pg from 'pg';
import pino from 'pino';
import { loadConfig } from '../adapters/env-config.ts';
import type { AppConfig } from '../core/config.ts';
import type { Logger } from '../core/ports.ts';

/** Config, logger, and pool shared by every entrypoint, plus ordered graceful shutdown. */
export function createRuntime(role: string) {
  const config = loadConfig();
  const logger = pino({ level: config.logLevel, base: { role } });
  const pool = createPool(config, logger, { api: role === 'server' });

  const shutdownSteps: (() => Promise<void>)[] = [];
  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    for (const step of shutdownSteps.reverse()) {
      await step().catch((err: unknown) => {
        logger.error({ err }, 'Shutdown step failed');
      });
    }
    await pool.end();
    logger.info('Stopped');
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void shutdown(signal).finally(() => process.exit(0));
    });
  }

  return {
    config,
    logger,
    pool,
    /** Steps run in reverse registration order on SIGTERM/SIGINT, before the pool closes. */
    onShutdown: (step: () => Promise<void>) => {
      shutdownSteps.push(step);
    },
  };
}

/** The database pool every role uses; `api` adds request-sized statement and lock limits. */
export function createPool(
  config: AppConfig,
  logger: Logger,
  options: { api: boolean; max?: number; connectionTimeoutMillis?: number },
): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    ...(options.max !== undefined && { max: options.max }),
    // Waiting for a connection fails after this instead of hanging the caller.
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
    // A transaction left open must not hold locks indefinitely.
    idle_in_transaction_session_timeout: 60_000,
    // API requests never need long statements or lock waits; jobs and migrations may.
    ...(options.api && { statement_timeout: 30_000, lock_timeout: 10_000 }),
  });
  pool.on('error', (err) => {
    logger.error({ err }, 'Idle database connection failed');
  });
  return pool;
}

/**
 * Database pool usage and the longest event-loop delay since the previous snapshot: a waiting
 * pool points at the database, a long delay at blocking work, neither at the libuv threadpool.
 */
export function processSnapshot(pool: pg.Pool): () => Record<string, unknown> {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  return () => {
    const snapshot = {
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      eventLoopDelayMaxMs: Math.round(delay.max / 1e6),
    };
    delay.reset();
    return snapshot;
  };
}
