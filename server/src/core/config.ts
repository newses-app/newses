export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface FeedSettings {
  /** Default interval between fetches of a feed; subscriptions may override it. */
  updateIntervalSeconds: number;
  /** Default age after which entries are purged; 0 never purges. Subscriptions may override it. */
  purgeDays: number;
  /** Consecutive failures after which a feed is disabled. */
  disableAfterFailures: number;
}

export interface AppConfig {
  databaseUrl: string;
  /** `trustProxy` is true, false, or comma-separated proxy addresses/CIDRs. */
  http: { host: string; port: number; trustProxy: boolean | string };
  logLevel: LogLevel;
  blobDir: string;
  feeds: FeedSettings;
  /** Private addresses feeds may be fetched from: true for all, or CIDRs. Blocked by default. */
  fetchAllowPrivateNetworks: boolean | string[];
  /** Creates this admin on startup when the database has no users. */
  bootstrapAdmin: { login: string; password: string } | null;
}
