export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface AppConfig {
  databaseUrl: string;
  http: { host: string; port: number };
  logLevel: LogLevel;
  blobDir: string;
}
