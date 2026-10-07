import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';

let dir: string;
let app: ReturnType<typeof buildApp>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'web-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>app</title>');
  writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
  app = buildApp({ logger: pino({ level: 'silent' }), healthChecks: {}, webDir: dir });
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true });
});

describe('web app serving', () => {
  it('serves index.html with security headers for the root and client routes', async () => {
    for (const url of ['/', '/all', '/f12/34?q=x', '/settings/feeds']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(200);
      expect(response.body).toContain('<title>app</title>');
      expect(response.headers['content-security-policy']).toContain("script-src 'self'");
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['cache-control']).toBe('no-cache');
    }
  });

  it('caches fingerprinted assets and keeps API 404s as JSON', async () => {
    const asset = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(asset.headers['cache-control']).toContain('immutable');
    expect(asset.headers['content-security-policy']).toBeUndefined();
    const api = await app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toMatchObject({ error: 'not_found' });
    expect((await app.inject({ method: 'POST', url: '/all' })).statusCode).toBe(404);
    const unknown = await app.inject({ method: 'GET', url: '/public/nope' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.body).not.toContain('<title>app</title>');
  });
});
