import { describe, expect, it } from 'vitest';
import {
  buildManifest,
  checkBuiltFiles,
  FEEDS,
  installerNames,
  renderIndex,
  rewriteFeed,
  uploadPlan,
} from './manifest.ts';

const version = '1.2.3-rc.1';
const names = installerNames(version);
const built = [...Object.values(names), `${names.windows}.blockmap`, ...FEEDS];

// electron-builder's latest-linux.yml, as built.
const linuxFeed = `version: 1.2.3-rc.1
files:
  - url: rss-reader-1.2.3-rc.1-linux-x86_64.AppImage
    sha512: abc==
    size: 125523051
    blockMapSize: 132223
  - url: rss-reader-1.2.3-rc.1-linux-amd64.deb
    sha512: def==
    size: 99257992
path: rss-reader-1.2.3-rc.1-linux-x86_64.AppImage
sha512: abc==
releaseDate: '2026-10-10T20:01:43.112Z'
`;

describe('checkBuiltFiles', () => {
  it("accepts exactly the version's installers, block map, and feeds", () => {
    expect(() => {
      checkBuiltFiles(version, built);
    }).not.toThrow();
  });

  it('refuses a missing or unexpected file', () => {
    expect(() => {
      checkBuiltFiles(version, built.slice(1));
    }).toThrow(/missing \[rss-reader/);
    expect(() => {
      checkBuiltFiles(version, [...built, 'rss-reader-1.2.2-android.apk']);
    }).toThrow(/unexpected \[rss-reader-1\.2\.2-android\.apk\]/);
  });
});

describe('rewriteFeed', () => {
  it("points the feed's files at the version folder", () => {
    const feed = rewriteFeed(linuxFeed, version);
    expect(feed).toContain(`  - url: ${version}/${names.appImage}\n`);
    expect(feed).toContain(`  - url: ${version}/${names.deb}\n`);
    expect(feed).toContain(`path: ${version}/${names.appImage}\n`);
    expect(feed).toContain('sha512: abc==\n');
  });

  it('refuses a feed for another version', () => {
    expect(() => rewriteFeed(linuxFeed, '1.2.3')).toThrow(/not for version 1\.2\.3/);
  });
});

describe('buildManifest', () => {
  it('lists each installer with its URL, size, and hash', () => {
    const manifest = buildManifest({
      version,
      versionCode: 10203,
      prerelease: true,
      published: new Date('2026-10-10T12:00:00Z'),
      baseUrl: 'https://reader-dev.example.com/downloads',
      files: built.map((name, i) => ({ name, size: i, sha256: `hash${String(i)}` })),
    });
    expect(manifest).toEqual({
      version,
      prerelease: true,
      published: '2026-10-10T12:00:00.000Z',
      windows: {
        installer: {
          url: `https://reader-dev.example.com/downloads/${version}/${names.windows}`,
          size: 0,
          sha256: 'hash0',
        },
        zip: expect.objectContaining({ size: 1 }) as unknown,
      },
      linux: {
        appImage: expect.objectContaining({ size: 2 }) as unknown,
        deb: expect.objectContaining({ size: 3 }) as unknown,
      },
      android: expect.objectContaining({ versionCode: 10203, size: 4 }) as unknown,
    });
    const page = renderIndex(manifest);
    expect(page).toContain(`<a href="${manifest.windows.zip.url}">`);
    expect(page).toContain(`<a href="${manifest.android.url}">`);
  });
});

describe('uploadPlan', () => {
  it('uploads immutable versioned files before the no-cache files that point at them', () => {
    const plan = uploadPlan(version, 'downloads');
    expect(plan.map((u) => u.key)).toEqual([
      `downloads/${version}/${names.windows}`,
      `downloads/${version}/${names.windowsZip}`,
      `downloads/${version}/${names.appImage}`,
      `downloads/${version}/${names.deb}`,
      `downloads/${version}/${names.android}`,
      `downloads/${version}/${names.windows}.blockmap`,
      'downloads/latest.yml',
      'downloads/latest-linux.yml',
      'downloads/latest.json',
      'downloads/index.html',
    ]);
    expect(plan.find((u) => u.name === names.android)).toEqual(
      expect.objectContaining({
        contentType: 'application/vnd.android.package-archive',
        cacheControl: 'public, max-age=31536000, immutable',
        attachment: true,
      }),
    );
    expect(plan.find((u) => u.name === 'latest.yml')).toEqual(
      expect.objectContaining({ contentType: 'text/yaml', cacheControl: 'no-cache' }),
    );
  });
});
