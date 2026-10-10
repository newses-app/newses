import { describe, expect, it } from 'vitest';
import { versionFromTag } from './release.ts';

describe('versionFromTag', () => {
  it('derives the version name and code from a release tag', () => {
    expect(versionFromTag('v1.2.3')).toEqual({ name: '1.2.3', code: 10203 });
    expect(versionFromTag('v0.4.0-rc.1')).toEqual({ name: '0.4.0-rc.1', code: 400 });
    expect(versionFromTag('12.0.99')).toEqual({ name: '12.0.99', code: 120099 });
  });

  it('gives local builds a development version', () => {
    expect(versionFromTag(undefined)).toEqual({ name: '0.0.0-dev', code: 1 });
    expect(versionFromTag('')).toEqual({ name: '0.0.0-dev', code: 1 });
  });

  it('refuses tags that are not versions, or would collide', () => {
    expect(() => versionFromTag('release-1')).toThrow();
    expect(() => versionFromTag('v1.2')).toThrow();
    expect(() => versionFromTag('v1.100.0')).toThrow();
    expect(() => versionFromTag('v0.0.0-try.1')).toThrow(/start at 0\.0\.1/);
  });
});
