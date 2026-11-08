import { describe, expect, it } from 'vitest';
import { imageDigestName, imageRepositoryName, parseDigest, planTags } from './image.ts';

describe('imageRepositoryName', () => {
  it('drops the registry and alias', () => {
    expect(imageRepositoryName('public.ecr.aws/newses/newses')).toBe('newses');
    expect(imageRepositoryName('public.ecr.aws/a1b2c3d4/team/newses-server')).toBe(
      'team/newses-server',
    );
  });
});

describe('parseDigest', () => {
  const digest = `sha256:${'a1'.repeat(32)}`;

  it("takes a digest file's digest", () => {
    expect(parseDigest(`${digest}\n`)).toBe(digest);
    expect(imageDigestName('arm64')).toBe('image-arm64.digest');
  });

  it('refuses anything else', () => {
    expect(() => parseDigest('')).toThrow(/Not an image digest/);
    expect(() => parseDigest(`sha256:${'A1'.repeat(32)}`)).toThrow(/Not an image digest/);
    expect(() => parseDigest(`newses@${digest}`)).toThrow(/Not an image digest/);
  });
});

describe('planTags', () => {
  it('moves every floating tag for the first release', () => {
    expect(planTags('1.0.0', [])).toEqual({
      version: '1.0.0',
      floating: ['1.0', '1', 'latest'],
      superseded: [],
    });
  });

  it('moves them for the newest release, ignoring prerelease and floating tags', () => {
    expect(
      planTags('1.3.0', ['1.2.4', '1.2', '1', 'latest', '2.0.0-rc.1', 'next']).floating,
    ).toEqual(['1.3', '1', 'latest']);
  });

  it("moves only an older line's tags for a patch to it", () => {
    const existing = ['1.2.3', '1.3.0', '2.0.0', '1.2', '1.3', '1', '2', 'latest'];
    expect(planTags('1.2.4', existing).floating).toEqual(['1.2']);
    expect(planTags('1.3.1', existing).floating).toEqual(['1.3', '1']);
    expect(planTags('2.0.1', existing).floating).toEqual(['2.0', '2', 'latest']);
  });

  it('compares versions as numbers', () => {
    expect(planTags('1.10.0', ['1.9.9']).floating).toEqual(['1.10', '1', 'latest']);
    expect(planTags('1.9.10', ['1.10.0']).floating).toEqual(['1.9']);
  });

  it('keeps the floating tags of a release published again', () => {
    expect(planTags('1.2.3', ['1.2.3', '1.2', '1', 'latest']).floating).toEqual([
      '1.2',
      '1',
      'latest',
    ]);
  });

  it('moves next for a prerelease and supersedes every other prerelease', () => {
    expect(
      planTags('1.3.0-rc.2', ['1.2.3', 'latest', '1.3.0-rc.1', '0.0.1-try.1', 'next']),
    ).toEqual({
      version: '1.3.0-rc.2',
      floating: ['next'],
      superseded: ['1.3.0-rc.1', '0.0.1-try.1'],
    });
    expect(planTags('1.3.0-rc.2', ['1.3.0-rc.2', 'next']).superseded).toEqual([]);
  });

  it('refuses a tag that is not a version', () => {
    expect(() => planTags('latest', [])).toThrow(/Not a version/);
  });
});
