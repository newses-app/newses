import { z } from 'zod';
import { MAX_INSTANCE_NAME_LENGTH, passwordSchema } from '@newses/shared';
import { sourceAt } from '@newses/shared/release';
// The image and the Lambda bundles carry it; forks name their own repository there.
import rootPackage from '../../../package.json' with { type: 'json' };
import type { AppConfig } from '../core/config.ts';

const schema = z
  .object({
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    APP_SECRET: z.string().min(32, 'APP_SECRET needs at least 32 characters'),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    BLOB_DIR: z.string().min(1).default('/data/blobs'),
    BLOB_BUCKET: z.string().min(1).optional(),
    WEB_DIR: z.string().min(1).optional(),
    DOWNLOADS_DIR: z.string().min(1).optional(),
    PUBLIC_URL: z
      .url({ protocol: /^https?$/ })
      .transform((v) => v.replace(/\/+$/, ''))
      .optional(),
    TRUST_PROXY: z
      .string()
      .default('false')
      .transform((v) =>
        v === 'true' ? true : v === 'false' ? false : /^\d+$/.test(v) ? Number(v) : v,
      ),
    FETCH_ALLOW_PRIVATE_NETWORKS: z
      .string()
      .default('')
      .transform((v) =>
        v === 'true'
          ? true
          : v
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
      ),
    PUSH_TRUSTED_HOSTS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      ),
    PUSH_DISTRIBUTOR_URL: z
      .url({ protocol: /^https$/ })
      .transform((v) => v.replace(/\/+$/, ''))
      .optional(),
    PUSH_TOKENS: z
      .string()
      .default('')
      .refine(
        (v) => pushTokenPairs(v).every(([host, token]) => host && PUSH_TOKEN.test(token)),
        'comma-separated host=token pairs',
      )
      .transform((v) => new Map(pushTokenPairs(v))),
    COMPAT_TRACE: z.enum(['true', 'false']).default('false'),
    ARCHIVE_ENABLED: z.enum(['true', 'false']).default('true'),
    ARCHIVE_ATHENA_WORKGROUP: z.string().min(1).optional(),
    ARCHIVE_ATHENA_DATABASE: z.string().min(1).optional(),
    NEWSES_VERSION: z.string().default('dev'),
    INSTANCE_NAME: z.string().trim().min(1).max(MAX_INSTANCE_NAME_LENGTH).optional(),
    SOURCE_URL: z.url({ protocol: /^https?$/ }).optional(),
    FEED_UPDATE_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
    FEED_PURGE_DAYS: z.coerce.number().int().min(0).default(180),
    FEED_DISABLE_AFTER_FAILURES: z.coerce.number().int().min(1).default(20),
    OPS_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
    AUDIT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(365),
    OPS_HOST_HOURLY_BUDGET: z.coerce.number().int().min(1).default(200),
    SMTP_URL: z.url({ protocol: /^smtps?$/ }).optional(),
    MAIL_FROM: z.string().min(3).optional(),
    MAIL_SES_CONFIGURATION_SET: z.string().min(1).optional(),
    ALERT_EMAIL_TO: z.string().min(3).optional(),
    ALERT_EMAIL_FROM: z.string().min(3).optional(),
    ADMIN_LOGIN: z.string().min(1).optional(),
    ADMIN_PASSWORD: passwordSchema.optional(),
  })
  .refine((e) => (e.ADMIN_LOGIN === undefined) === (e.ADMIN_PASSWORD === undefined), {
    message: 'ADMIN_LOGIN and ADMIN_PASSWORD must be set together',
    path: ['ADMIN_PASSWORD'],
  })
  .refine((e) => e.ALERT_EMAIL_TO === undefined || e.SMTP_URL !== undefined, {
    message: 'ALERT_EMAIL_TO needs SMTP_URL',
    path: ['SMTP_URL'],
  })
  .refine((e) => e.SMTP_URL === undefined || e.MAIL_SES_CONFIGURATION_SET === undefined, {
    message: 'SMTP_URL and MAIL_SES_CONFIGURATION_SET cannot both be set',
    path: ['MAIL_SES_CONFIGURATION_SET'],
  })
  .refine(
    (e) => (e.ARCHIVE_ATHENA_WORKGROUP === undefined) === (e.ARCHIVE_ATHENA_DATABASE === undefined),
    {
      message: 'ARCHIVE_ATHENA_WORKGROUP and ARCHIVE_ATHENA_DATABASE must be set together',
      path: ['ARCHIVE_ATHENA_DATABASE'],
    },
  );

const PUSH_TOKEN = /^[^\s,=]+$/;

/** `host=token` pairs, comma-separated; a pair that is not exactly that gets no token. */
function pushTokenPairs(value: string): [string, string][] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const [host = '', token = '', ...rest] = pair.split('=');
      return [host.trim().toLowerCase(), rest.length > 0 ? '' : token.trim()];
    });
}

/** `Newses <newses@host>` on the public URL's host, so mail aligns with the instance's domain. */
function defaultMailFrom(publicUrl: string | undefined): string {
  return `Newses <newses@${publicUrl ? new URL(publicUrl).hostname : 'localhost'}>`;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Reads AppConfig from environment variables; throws ConfigError listing every problem. */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  // Compose passes unset variables as empty strings; treat them as unset.
  const result = schema.safeParse(
    Object.fromEntries(Object.entries(env).filter(([, value]) => value !== '')),
  );
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new ConfigError(`Invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  const e = result.data;
  const mailFrom = e.MAIL_FROM ?? defaultMailFrom(e.PUBLIC_URL);
  return {
    version: e.NEWSES_VERSION,
    instanceName: e.INSTANCE_NAME ?? null,
    sourceUrl: e.SOURCE_URL ?? sourceAt(rootPackage.repository.url, e.NEWSES_VERSION),
    databaseUrl: e.DATABASE_URL,
    http: { host: e.HOST, port: e.PORT, trustProxy: e.TRUST_PROXY },
    logLevel: e.LOG_LEVEL,
    blobDir: e.BLOB_DIR,
    blobBucket: e.BLOB_BUCKET ?? null,
    webDir: e.WEB_DIR ?? null,
    downloadsDir: e.DOWNLOADS_DIR ?? null,
    publicUrl: e.PUBLIC_URL ?? null,
    compatTrace: e.COMPAT_TRACE === 'true',
    archiveEnabled: e.ARCHIVE_ENABLED === 'true',
    archiveAthena:
      e.ARCHIVE_ATHENA_WORKGROUP && e.ARCHIVE_ATHENA_DATABASE
        ? { workgroup: e.ARCHIVE_ATHENA_WORKGROUP, database: e.ARCHIVE_ATHENA_DATABASE }
        : null,
    feeds: {
      updateIntervalSeconds: e.FEED_UPDATE_INTERVAL_MINUTES * 60,
      purgeDays: e.FEED_PURGE_DAYS,
      disableAfterFailures: e.FEED_DISABLE_AFTER_FAILURES,
    },
    ops: {
      retentionDays: e.OPS_RETENTION_DAYS,
      auditRetentionDays: e.AUDIT_RETENTION_DAYS,
      hostHourlyBudget: e.OPS_HOST_HOURLY_BUDGET,
      alertEmail:
        e.SMTP_URL && e.ALERT_EMAIL_TO
          ? { smtpUrl: e.SMTP_URL, to: e.ALERT_EMAIL_TO, from: e.ALERT_EMAIL_FROM ?? mailFrom }
          : null,
    },
    mail: e.SMTP_URL
      ? { from: mailFrom, transport: { kind: 'smtp', url: e.SMTP_URL } }
      : e.MAIL_SES_CONFIGURATION_SET
        ? {
            from: mailFrom,
            transport: { kind: 'ses', configurationSet: e.MAIL_SES_CONFIGURATION_SET },
          }
        : null,
    fetchAllowPrivateNetworks:
      e.FETCH_ALLOW_PRIVATE_NETWORKS === true || e.FETCH_ALLOW_PRIVATE_NETWORKS.length > 0
        ? e.FETCH_ALLOW_PRIVATE_NETWORKS
        : false,
    push: {
      trustedHosts: e.PUSH_TRUSTED_HOSTS,
      distributorUrl: e.PUSH_DISTRIBUTOR_URL ?? null,
      tokens: e.PUSH_TOKENS,
    },
    appSecret: e.APP_SECRET,
    bootstrapAdmin:
      e.ADMIN_LOGIN && e.ADMIN_PASSWORD
        ? { login: e.ADMIN_LOGIN, password: e.ADMIN_PASSWORD }
        : null,
  };
}
