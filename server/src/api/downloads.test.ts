import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';

let web: string;
let downloads: string;
let app: ReturnType<typeof buildApp>;
let bare: ReturnType<typeof buildApp>;

beforeAll(() => {
  web = mkdtempSync(join(tmpdir(), 'web-'));
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>app</title>');
  downloads = mkdtempSync(join(tmpdir(), 'downloads-'));
  mkdirSync(join(downloads, '1.2.3'));
  writeFileSync(join(downloads, 'index.html'), '<!doctype html><title>downloads</title>');
  writeFileSync(join(downloads, 'latest.json'), '{"version":"1.2.3"}');
  writeFileSync(join(downloads, 'latest-linux.yml'), 'version: 1.2.3\n');
  writeFileSync(join(downloads, '1.2.3', 'newses-1.2.3-android.apk'), 'apk');
  writeFileSync(join(downloads, '1.2.3', 'newses-1.2.3-linux-x86_64.AppImage'), 'appimage');
  writeFileSync(join(downloads, '1.2.3', 'newses-1.2.3-desktop.cdx.json'), '{}');
  writeFileSync(join(downloads, '1.2.3', 'SHA256SUMS'), '');
  const logger = pino({ level: 'silent' });
  app = buildApp({ logger, healthChecks: {}, webDir: web, downloadsDir: downloads });
  bare = buildApp({ logger, healthChecks: {}, webDir: web });
});

afterAll(async () => {
  await app.close();
  await bare.close();
  rmSync(web, { recursive: true });
  rmSync(downloads, { recursive: true });
});

const get = (url: string, on = app) => on.inject({ method: 'GET', url });

describe('downloads serving', () => {
  it('serves the page at /downloads/, without scripts, and redirects /downloads to it', async () => {
    const redirect = await get('/downloads');
    expect(redirect.statusCode).toBe(301);
    expect(redirect.headers.location).toBe('/downloads/');
    const page = await get('/downloads/');
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<title>downloads</title>');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.headers['content-security-policy']).not.toContain('script-src');
    expect(page.headers['cache-control']).toBe('no-cache');
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
  });

  it('revalidates the feeds and latest.json, and caches versioned files for good', async () => {
    const feed = await get('/downloads/latest-linux.yml');
    expect(feed.headers['content-type']).toBe('text/yaml; charset=utf-8');
    expect(feed.headers['cache-control']).toBe('no-cache');
    const manifest = await get('/downloads/latest.json');
    expect(manifest.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(manifest.headers['cache-control']).toBe('no-cache');
    const sums = await get('/downloads/1.2.3/SHA256SUMS');
    expect(sums.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(sums.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('downloads installers as attachments with their types, and SBOMs inline', async () => {
    const apk = await get('/downloads/1.2.3/newses-1.2.3-android.apk');
    expect(apk.statusCode).toBe(200);
    expect(apk.body).toBe('apk');
    expect(apk.headers['content-type']).toBe('application/vnd.android.package-archive');
    expect(apk.headers['content-disposition']).toBe(
      'attachment; filename="newses-1.2.3-android.apk"',
    );
    const appImage = await get('/downloads/1.2.3/newses-1.2.3-linux-x86_64.AppImage');
    expect(appImage.headers['content-type']).toBe('application/vnd.appimage');
    const sbom = await get('/downloads/1.2.3/newses-1.2.3-desktop.cdx.json');
    expect(sbom.headers['content-type']).toBe('application/vnd.cyclonedx+json');
    expect(sbom.headers['content-disposition']).toBeUndefined();
    const head = await app.inject({ method: 'HEAD', url: '/downloads/latest.json' });
    expect(head.statusCode).toBe(200);
  });

  it('answers 404, not the app, for missing files, other paths, or no downloads', async () => {
    for (const [url, on] of [
      ['/downloads/1.2.3/missing.apk', app],
      ['/downloads/1.2.2/', app],
      ['/downloads/..%2f..%2fetc%2fpasswd', app],
      ['/downloads/', bare],
      ['/downloads/latest.json', bare],
    ] as const) {
      const response = await get(url, on);
      expect(response.statusCode, url).toBe(404);
      expect(response.body, url).not.toContain('<title>app</title>');
    }
  });
});
