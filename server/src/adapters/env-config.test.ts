import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './env-config.ts';

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://u:p@db:5432/app' })).toEqual({
      databaseUrl: 'postgres://u:p@db:5432/app',
      http: { host: '0.0.0.0', port: 8080, trustProxy: false },
      logLevel: 'info',
      blobDir: '/data/blobs',
      fetchAllowPrivateNetworks: false,
      bootstrapAdmin: null,
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
    expect(config.http).toEqual({ host: '127.0.0.1', port: 3000, trustProxy: false });
    expect(config.logLevel).toBe('debug');
    expect(config.blobDir).toBe('/tmp/blobs');
  });

  it('parses proxy trust and admin bootstrap', () => {
    const base = { DATABASE_URL: 'postgres://db/app' };
    expect(loadConfig({ ...base, TRUST_PROXY: 'true' }).http.trustProxy).toBe(true);
    expect(loadConfig({ ...base, TRUST_PROXY: '10.0.0.0/8' }).http.trustProxy).toBe('10.0.0.0/8');
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
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/DATABASE_URL[\s\S]*PORT/);
  });
});
