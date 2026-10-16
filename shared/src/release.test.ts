import { describe, expect, it } from 'vitest';
import { versionFromTag } from './release.ts';

describe('versionFromTag', () => {
  it('derives the version name and code from a release tag', () => {
    expect(versionFromTag('v1.2.3')).toEqual({ name: '1.2.3', code: 1020399 });
    expect(versionFromTag('v0.4.0-rc.1')).toEqual({ name: '0.4.0-rc.1', code: 40001 });
    expect(versionFromTag('12.0.99')).toEqual({ name: '12.0.99', code: 12009999 });
    expect(versionFromTag('v0.0.1-try.1700000000')).toEqual({
      name: '0.0.1-try.1700000000',
      code: 100,
    });
  });

  it('orders each rc above the last and below the release', () => {
    const codes = [
      'v1.2.2',
      'v1.2.3-try.1',
      'v1.2.3-rc.1',
      'v1.2.3-rc.2',
      'v1.2.3-rc.98',
      'v1.2.3',
    ].map((tag) => versionFromTag(tag).code);
    expect(codes).toEqual([...codes].sort((a, b) => a - b));
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('gives local builds a development version', () => {
    expect(versionFromTag(undefined)).toEqual({ name: '0.0.0-dev', code: 1 });
    expect(versionFromTag('')).toEqual({ name: '0.0.0-dev', code: 1 });
  });

  it('refuses tags that are not versions, or would collide', () => {
    expect(() => versionFromTag('release-1')).toThrow();
    expect(() => versionFromTag('v1.2')).toThrow();
    expect(() => versionFromTag('v1.100.0')).toThrow();
    expect(() => versionFromTag('v2100.0.0')).toThrow(/below 2100/);
    for (const tag of [
      'v1.2.3-beta.1',
      'v1.2.3-rc1',
      'v1.2.3-rc.0',
      'v1.2.3-rc.99',
      'v1.2.3-rc.1.1',
    ])
      expect(() => versionFromTag(tag)).toThrow(/-rc\.1 to -rc\.98/);
    expect(() => versionFromTag('v0.0.0-try.1')).toThrow(/start at 0\.0\.1/);
    expect(() => versionFromTag('v0.0.0-rc.1')).toThrow(/start at 0\.0\.1/);
  });
});
