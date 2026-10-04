export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface AppConfig {
  databaseUrl: string;
  /** `trustProxy` is true, false, or comma-separated proxy addresses/CIDRs. */
  http: { host: string; port: number; trustProxy: boolean | string };
  logLevel: LogLevel;
  blobDir: string;
  /** Private addresses feeds may be fetched from: true for all, or CIDRs. Blocked by default. */
  fetchAllowPrivateNetworks: boolean | string[];
  /** Creates this admin on startup when the database has no users. */
  bootstrapAdmin: { login: string; password: string } | null;
}
