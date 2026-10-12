import { describe, expect, it } from 'vitest';
import { bomUploadRequest, releaseKind, uploadTarget } from './dtrack.ts';

describe('releaseKind', () => {
  it('tells releases, prereleases, and untagged builds apart', () => {
    expect(releaseKind('v1.2.3')).toBe('prod');
    expect(releaseKind('v1.2.3-rc.1')).toBe('dev');
    expect(releaseKind(undefined)).toBe('local');
  });
});

describe('uploadTarget', () => {
  it("makes a tagged build the release's latest version", () => {
    expect(uploadTarget('desktop', { tag: 'v1.2.3-rc.1' })).toEqual({
      projectName: 'rss-reader-desktop',
      projectVersion: '1.2.3-rc.1',
      tags: ['rss-reader', 'dev'],
      isLatest: true,
    });
  });

  it('files an untagged build under its branch, not as the latest', () => {
    expect(uploadTarget('server', { branch: 'dev' })).toEqual({
      projectName: 'rss-reader-server',
      projectVersion: 'dev',
      tags: ['rss-reader', 'local'],
      isLatest: false,
    });
  });

  it('needs a tag or a branch', () => {
    expect(() => uploadTarget('web', {})).toThrow(/tag or a branch/);
  });
});

describe('bomUploadRequest', () => {
  it('sends the SBOM base64-encoded and creates the project', () => {
    const body = bomUploadRequest(
      uploadTarget('image', { tag: 'v1.2.3' }),
      '{"bomFormat":"CycloneDX"}',
    );
    expect(body).toEqual({
      projectName: 'rss-reader-image',
      projectVersion: '1.2.3',
      projectTags: [{ name: 'rss-reader' }, { name: 'prod' }],
      autoCreate: true,
      isLatest: true,
      bom: Buffer.from('{"bomFormat":"CycloneDX"}').toString('base64'),
    });
  });
});
