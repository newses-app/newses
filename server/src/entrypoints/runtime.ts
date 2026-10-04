import pg from 'pg';
import pino from 'pino';
import { loadConfig } from '../adapters/env-config.ts';

/** Config, logger, and pool shared by every entrypoint, plus ordered graceful shutdown. */
export function createRuntime(role: string) {
  const config = loadConfig();
  const logger = pino({ level: config.logLevel, base: { role } });
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
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
