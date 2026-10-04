import { z } from 'zod';
import type { AppConfig } from '../core/config.ts';

const schema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  BLOB_DIR: z.string().min(1).default('/data/blobs'),
});

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Reads AppConfig from environment variables; throws ConfigError listing every problem. */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new ConfigError(`Invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  const e = result.data;
  return {
    databaseUrl: e.DATABASE_URL,
    http: { host: e.HOST, port: e.PORT },
    logLevel: e.LOG_LEVEL,
    blobDir: e.BLOB_DIR,
  };
}
