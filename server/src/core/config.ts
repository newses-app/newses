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
  /** Built web app to serve, or null when it is hosted elsewhere. */
  webDir: string | null;
  feeds: FeedSettings;
  /** Private addresses feeds may be fetched from: true for all, or CIDRs. Blocked by default. */
  fetchAllowPrivateNetworks: boolean | string[];
  /** Root of the keys that encrypt stored secrets and sign tokens; changing it voids them. */
  appSecret: string;
  /** Creates this admin on startup when the database has no users. */
  bootstrapAdmin: { login: string; password: string } | null;
}
