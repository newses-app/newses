import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './env-config.ts';

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://u:p@db:5432/app' })).toEqual({
      databaseUrl: 'postgres://u:p@db:5432/app',
      http: { host: '0.0.0.0', port: 8080 },
      logLevel: 'info',
      blobDir: '/data/blobs',
    });
  });

  it('parses overrides', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://db/app',
      HOST: '127.0.0.1',
      PORT: '3000',
      LOG_LEVEL: 'debug',
      BLOB_DIR: '/tmp/blobs',
    });
    expect(config.http).toEqual({ host: '127.0.0.1', port: 3000 });
    expect(config.logLevel).toBe('debug');
    expect(config.blobDir).toBe('/tmp/blobs');
  });

  it('reports every invalid variable', () => {
    expect(() => loadConfig({ DATABASE_URL: 'mysql://db/app', PORT: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/DATABASE_URL[\s\S]*PORT/);
  });
});
