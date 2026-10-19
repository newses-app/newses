export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface FeedSettings {
  /** Default interval between fetches of a feed; subscriptions may override it. */
  updateIntervalSeconds: number;
  /** Default age after which entries are purged; 0 never purges. Subscriptions may override it. */
  purgeDays: number;
  /** Consecutive failures after which a feed is disabled. */
  disableAfterFailures: number;
}

export interface OpsSettings {
  /** Days of activity, request, fetch, and job statistics, and resolved alerts, to keep. */
  retentionDays: number;
  /** Days of audit events to keep. */
  auditRetentionDays: number;
  /** Requests to one host in an hour above which the ops check raises an alert. */
  hostHourlyBudget: number;
  /** Where alert emails go; null leaves alerts in the app only. */
  alertEmail: { smtpUrl: string; to: string; from: string } | null;
}

export interface AppConfig {
  /** Server build shown to apps (`NEWSES_VERSION`, set at build), or `dev`. */
  version: string;
  /** What the operator calls this server, shown to apps (`INSTANCE_NAME`); null without one. */
  instanceName: string | null;
  databaseUrl: string;
  /** `trustProxy` is true, false, a hop count, or comma-separated proxy addresses/CIDRs. */
  http: { host: string; port: number; trustProxy: boolean | number | string };
  logLevel: LogLevel;
  blobDir: string;
  /** S3 bucket for blobs; when set, `blobDir` is unused. */
  blobBucket: string | null;
  /** Origin of public links (published feeds), e.g. `https://reader.example`; null uses the request's. */
  publicUrl: string | null;
  /** Log every compatibility-API call, credentials redacted, to capture client behaviour. */
  compatTrace: boolean;
  /** Purge writes what it deletes to the cold-storage archive under the blob root. */
  archiveEnabled: boolean;
  /** Athena reads the archive in `blobBucket` through this workgroup and Glue database. */
  archiveAthena: { workgroup: string; database: string } | null;
  /** Built web app to serve, or null when it is hosted elsewhere. */
  webDir: string | null;
  feeds: FeedSettings;
  ops: OpsSettings;
  /** Private addresses feeds may be fetched from: true for all, or CIDRs. Blocked by default. */
  fetchAllowPrivateNetworks: boolean | string[];
  /** Root of the keys that encrypt stored secrets and sign tokens; changing it voids them. */
  appSecret: string;
  /** Creates this admin on startup when the database has no users. */
  bootstrapAdmin: { login: string; password: string } | null;
}
