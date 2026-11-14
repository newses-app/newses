import type { ThirdPartyLicense } from '@newses/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bundledLicenses, filterLicenses } from './licenses.ts';

const license = (name: string, spdx: string): ThirdPartyLicense => ({
  name,
  version: '1.0.0',
  license: spdx,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('bundledLicenses', () => {
  it('reads the list the build wrote beside the app', async () => {
    const fetch = vi.fn(() => Promise.resolve(Response.json([license('vue', 'MIT')])));
    vi.stubGlobal('fetch', fetch);
    await expect(bundledLicenses('licenses.json')).resolves.toEqual([license('vue', 'MIT')]);
    expect(fetch).toHaveBeenCalledWith('/licenses.json');
  });

  it('is null without a list, or when it cannot be read', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('', { status: 404 })));
    await expect(bundledLicenses('licenses.json')).resolves.toBeNull();
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('<!doctype html>')));
    await expect(bundledLicenses('licenses.json')).resolves.toBeNull();
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    await expect(bundledLicenses('licenses.json')).resolves.toBeNull();
  });
});

describe('filterLicenses', () => {
  const all = [license('vue', 'MIT'), license('dexie', 'Apache-2.0'), license('Inter', 'OFL-1.1')];

  it('keeps packages whose name or licence contains the filter, ignoring case and spaces', () => {
    expect(filterLicenses(all, ' apache ').map((l) => l.name)).toEqual(['dexie']);
    expect(filterLicenses(all, 'INTER').map((l) => l.name)).toEqual(['Inter']);
    expect(filterLicenses(all, 'nothing')).toEqual([]);
  });

  it('keeps everything for an empty filter', () => {
    expect(filterLicenses(all, '  ')).toBe(all);
  });
});
