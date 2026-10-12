import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './env-config.ts';

const APP_SECRET = '0123456789abcdef0123456789abcdef';

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://u:p@db:5432/app', APP_SECRET })).toEqual({
      version: 'dev',
      databaseUrl: 'postgres://u:p@db:5432/app',
      http: { host: '0.0.0.0', port: 8080, trustProxy: false },
      logLevel: 'info',
      blobDir: '/data/blobs',
      blobBucket: null,
      webDir: null,
      publicUrl: null,
      compatTrace: false,
      archiveEnabled: true,
      archiveAthena: null,
      feeds: { updateIntervalSeconds: 1800, purgeDays: 180, disableAfterFailures: 20 },
      fetchAllowPrivateNetworks: false,
      appSecret: APP_SECRET,
      bootstrapAdmin: null,
    });
  });

  it('trims the public URL and accepts only http(s)', () => {
    const base = { DATABASE_URL: 'postgres://db/app', APP_SECRET };
    expect(loadConfig({ ...base, PUBLIC_URL: 'https://reader.example/' }).publicUrl).toBe(
      'https://reader.example',
    );
    expect(() => loadConfig({ ...base, PUBLIC_URL: 'ftp://reader.example' })).toThrow(ConfigError);
  });

  it('turns on compatibility tracing only for true', () => {
    const base = { DATABASE_URL: 'postgres://db/app', APP_SECRET };
    expect(loadConfig({ ...base, COMPAT_TRACE: 'true' }).compatTrace).toBe(true);
    expect(() => loadConfig({ ...base, COMPAT_TRACE: 'yes' })).toThrow(ConfigError);
  });

  it('turns off the archive only for false', () => {
    const base = { DATABASE_URL: 'postgres://db/app', APP_SECRET };
    expect(loadConfig({ ...base, ARCHIVE_ENABLED: 'false' }).archiveEnabled).toBe(false);
    expect(() => loadConfig({ ...base, ARCHIVE_ENABLED: 'yes' })).toThrow(ConfigError);
    expect(
      loadConfig({ ...base, ARCHIVE_ATHENA_WORKGROUP: 'wg', ARCHIVE_ATHENA_DATABASE: 'db' })
        .archiveAthena,
    ).toEqual({ workgroup: 'wg', database: 'db' });
    expect(() => loadConfig({ ...base, ARCHIVE_ATHENA_WORKGROUP: 'wg' })).toThrow(ConfigError);
  });

  it('parses overrides', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://db/app',
      APP_SECRET,
      HOST: '127.0.0.1',
      PORT: '3000',
      LOG_LEVEL: 'debug',
      BLOB_DIR: '/tmp/blobs',
    });
    expect(config.http).toEqual({ host: '127.0.0.1', port: 3000, trustProxy: false });
    expect(config.logLevel).toBe('debug');
    expect(config.blobDir).toBe('/tmp/blobs');
  });

  it('parses proxy trust and admin bootstrap', () => {
    const base = { DATABASE_URL: 'postgres://db/app', APP_SECRET };
    expect(loadConfig({ ...base, TRUST_PROXY: 'true' }).http.trustProxy).toBe(true);
    expect(loadConfig({ ...base, TRUST_PROXY: '10.0.0.0/8' }).http.trustProxy).toBe('10.0.0.0/8');
    expect(loadConfig({ ...base, TRUST_PROXY: '2' }).http.trustProxy).toBe(2);
    expect(loadConfig({ ...base, BLOB_BUCKET: 'blobs' }).blobBucket).toBe('blobs');
    expect(
      loadConfig({ ...base, ADMIN_LOGIN: 'admin', ADMIN_PASSWORD: 'long enough' }).bootstrapAdmin,
    ).toEqual({ login: 'admin', password: 'long enough' });
    expect(() => loadConfig({ ...base, ADMIN_LOGIN: 'admin' })).toThrow(/set together/);
    expect(
      loadConfig({ ...base, FETCH_ALLOW_PRIVATE_NETWORKS: 'true' }).fetchAllowPrivateNetworks,
    ).toBe(true);
    expect(
      loadConfig({ ...base, FETCH_ALLOW_PRIVATE_NETWORKS: '192.168.1.0/24, 10.0.0.5' })
        .fetchAllowPrivateNetworks,
    ).toEqual(['192.168.1.0/24', '10.0.0.5']);
    expect(loadConfig({ ...base, ADMIN_LOGIN: '', ADMIN_PASSWORD: '' }).bootstrapAdmin).toBeNull();
  });

  it('reports every invalid variable', () => {
    expect(() => loadConfig({ DATABASE_URL: 'mysql://db/app', PORT: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/DATABASE_URL[\s\S]*APP_SECRET[\s\S]*PORT/);
    expect(() => loadConfig({ DATABASE_URL: 'postgres://db/app', APP_SECRET: 'short' })).toThrow(
      /at least 32 characters/,
    );
  });
});
