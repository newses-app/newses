import { monitorEventLoopDelay } from 'node:perf_hooks';
import pg from 'pg';
import pino from 'pino';
import { loadConfig } from '../adapters/env-config.ts';

/** Config, logger, and pool shared by every entrypoint, plus ordered graceful shutdown. */
export function createRuntime(role: string) {
  const config = loadConfig();
  const logger = pino({ level: config.logLevel, base: { role } });
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    // Waiting for a connection fails after this instead of hanging the caller.
    connectionTimeoutMillis: 10_000,
    // A transaction left open must not hold locks indefinitely.
    idle_in_transaction_session_timeout: 60_000,
    // API requests never need long statements or lock waits; jobs and migrations may.
    ...(role === 'server' && { statement_timeout: 30_000, lock_timeout: 10_000 }),
  });
  pool.on('error', (err) => {
    logger.error({ err }, 'Idle database connection failed');
  });

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
