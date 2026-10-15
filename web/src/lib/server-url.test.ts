import { API_VERSION } from '@newses/shared/client';
import { describe, expect, it } from 'vitest';
import { checkServer, compatibility, normaliseServerUrl } from './server-url.ts';

describe('normaliseServerUrl', () => {
  it('keeps the HTTPS origin of what was typed', () => {
    expect(normaliseServerUrl(' rr.example.com ')).toBe('https://rr.example.com');
    expect(normaliseServerUrl('https://rr.example.com:8443/all/')).toBe(
      'https://rr.example.com:8443',
    );
    expect(normaliseServerUrl('HTTPS://RR.example.com')).toBe('https://rr.example.com');
  });

  it('refuses plain HTTP and other schemes', () => {
    expect(normaliseServerUrl('http://rr.example.com')).toBeNull();
    expect(normaliseServerUrl('ftp://rr.example.com')).toBeNull();
    expect(normaliseServerUrl('javascript:alert(1)')).toBeNull();
    expect(normaliseServerUrl('')).toBeNull();
    expect(normaliseServerUrl('https://')).toBeNull();
  });
});

const info = (major: number, minor: number, product = 'newses') => ({
  product,
  version: 'abc1234',
  apiVersion: { major, minor },
});

describe('compatibility', () => {
  it('accepts this API version and newer minors', () => {
    expect(compatibility(info(API_VERSION.major, API_VERSION.minor)).status).toBe('ok');
    expect(compatibility(info(API_VERSION.major, API_VERSION.minor + 1)).status).toBe('ok');
  });

  it('warns about older minors and refuses other majors', () => {
    const required = { major: 2, minor: 3 };
    expect(compatibility(info(2, 4), required).status).toBe('ok');
    expect(compatibility(info(2, 2), required).status).toBe('older');
    expect(compatibility(info(1, 9), required).status).toBe('incompatible');
    expect(compatibility(info(3, 0), required).status).toBe('incompatible');
  });

  it('refuses other products', () => {
    expect(compatibility(info(API_VERSION.major, API_VERSION.minor, 'rss-reader')).status).toBe(
      'ok',
    );
    expect(compatibility(info(1, 0, 'other')).status).toBe('notNewses');
    expect(compatibility({ hello: 'world' }).status).toBe('notNewses');
    expect(compatibility(null).status).toBe('notNewses');
  });
});

describe('checkServer', () => {
  it('asks the server without credentials', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const fetch: typeof globalThis.fetch = (url, init) => {
      calls.push([url instanceof Request ? url.url : url.toString(), init]);
      return Promise.resolve(Response.json(info(API_VERSION.major, API_VERSION.minor)));
    };
    const result = await checkServer('https://rr.example.com', fetch);
    expect(result).toMatchObject({ status: 'ok', info: { version: 'abc1234' } });
    expect(calls[0]?.[0]).toBe('https://rr.example.com/api/v1/server');
    expect(calls[0]?.[1]?.credentials).toBe('omit');
  });

  it('reports failures as unreachable', async () => {
    const refused: typeof globalThis.fetch = () => Promise.reject(new TypeError('Failed'));
    expect(await checkServer('https://rr.example.com', refused)).toEqual({
      status: 'unreachable',
    });
    const missing: typeof globalThis.fetch = () =>
      Promise.resolve(new Response('Not found', { status: 404 }));
    expect(await checkServer('https://rr.example.com', missing)).toEqual({
      status: 'unreachable',
    });
  });
});
