import { describe, expect, it } from 'vitest';
import {
  buildManifest,
  checkBuiltFiles,
  FEEDS,
  installCommands,
  installerNames,
  renderChecksums,
  renderIndex,
  rewriteFeed,
  sbomArtifacts,
  sbomFiles,
  sbomNames,
  uploadPlan,
} from './manifest.ts';

const version = '1.2.3-rc.1';
const names = installerNames(version);
const sboms = sbomNames(version);
const built = [...Object.values(names), `${names.windows}.blockmap`, ...sboms, ...FEEDS];

// electron-builder's latest-linux.yml, as built.
const linuxFeed = `version: 1.2.3-rc.1
files:
  - url: newses-1.2.3-rc.1-linux-x86_64.AppImage
    sha512: abc==
    size: 125523051
    blockMapSize: 132223
  - url: newses-1.2.3-rc.1-linux-amd64.deb
    sha512: def==
    size: 99257992
path: newses-1.2.3-rc.1-linux-x86_64.AppImage
sha512: abc==
releaseDate: '2026-10-10T20:01:43.112Z'
`;

describe('checkBuiltFiles', () => {
  it("accepts exactly the version's installers, block map, SBOMs, and feeds", () => {
    expect(() => {
      checkBuiltFiles(version, built);
    }).not.toThrow();
  });

  it('refuses a missing or unexpected file', () => {
    expect(() => {
      checkBuiltFiles(version, built.slice(1));
    }).toThrow(/missing \[newses/);
    expect(() => {
      checkBuiltFiles(version, [...built, 'newses-1.2.2-android.apk']);
    }).toThrow(/unexpected \[newses-1\.2\.2-android\.apk\]/);
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

const files = built.map((name, i) => ({ name, size: i, sha256: `hash${String(i)}` }));
const input = {
  version,
  versionCode: 10203,
  prerelease: true,
  published: new Date('2026-10-10T12:00:00Z'),
  baseUrl: 'https://reader-dev.example.com/downloads',
  files,
};
const folder = `https://reader-dev.example.com/downloads/${version}/`;

describe('sbomArtifacts', () => {
  it('has the desktop SBOM describe both platforms and the Android one the APK', () => {
    expect(sbomArtifacts(version)).toEqual([
      {
        name: sboms[0],
        describes: [
          names.windows,
          names.windowsZip,
          names.windowsPortable,
          names.appImage,
          names.deb,
        ],
      },
      { name: sboms[1], describes: [names.android] },
    ]);
  });
});

describe('renderChecksums', () => {
  it("lists the build legs' versioned files, in sha256sum's format", () => {
    const lines = renderChecksums(version, files).trimEnd().split('\n');
    expect(lines).toHaveLength(9);
    expect(lines[0]).toBe(`hash0  ${names.windows}`);
    expect(lines.some((line) => line.endsWith('latest.yml'))).toBe(false);
    expect(lines.at(-1)).toBe(`hash8  ${sboms[1] ?? ''}`);
  });

  it('refuses a missing file', () => {
    expect(() => renderChecksums(version, files.slice(1))).toThrow(/Missing/);
  });
});

describe('installCommands', () => {
  const file = { url: `${folder}${names.deb}`, size: 1, sha256: 'abc123' };

  it('downloads, checks, and installs on Linux', () => {
    expect(installCommands('deb', file)).toEqual([
      `curl -fLO ${folder}${names.deb}`,
      `echo 'abc123  ${names.deb}' | sha256sum -c`,
      `sudo apt install ./${names.deb}`,
    ]);
  });

  it('checks the hash in PowerShell on Windows', () => {
    const commands = installCommands('windows', {
      ...file,
      url: `${folder}${names.windows}`,
    });
    expect(commands).toContain(
      `(Get-FileHash ${names.windows} -Algorithm SHA256).Hash -eq 'abc123'`,
    );
    expect(commands.at(-1)).toBe(`.\\${names.windows}`);
  });

  it('runs the portable exe where it was downloaded', () => {
    const commands = installCommands('windowsPortable', {
      ...file,
      url: `${folder}${names.windowsPortable}`,
    });
    expect(commands).toEqual([
      `curl.exe -fLO ${folder}${names.windowsPortable}`,
      '# True when the file is intact',
      `(Get-FileHash ${names.windowsPortable} -Algorithm SHA256).Hash -eq 'abc123'`,
      `.\\${names.windowsPortable}`,
    ]);
  });

  it('only downloads and checks an SBOM', () => {
    expect(installCommands('sbom', file)).toHaveLength(2);
  });
});

describe('buildManifest', () => {
  it('lists each installer with its URL, size, and hash', () => {
    const manifest = buildManifest(input);
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
        portable: {
          url: `https://reader-dev.example.com/downloads/${version}/${names.windowsPortable}`,
          size: 2,
          sha256: 'hash2',
        },
      },
      linux: {
        appImage: expect.objectContaining({ size: 3 }) as unknown,
        deb: expect.objectContaining({ size: 4 }) as unknown,
      },
      android: expect.objectContaining({ versionCode: 10203, size: 5 }) as unknown,
    });
  });
});

describe('renderIndex', () => {
  const manifest = buildManifest(input);
  const page = renderIndex(manifest, sbomFiles(input));

  it('links each installer and SBOM with its hash and commands', () => {
    expect(page).toContain(`<a href="${manifest.windows.zip.url}">`);
    expect(page).toContain(`<a href="${manifest.windows.portable.url}">`);
    expect(page).toContain(`<a href="${manifest.android.url}">`);
    expect(page).toContain(`<a href="${folder}${sboms[1] ?? ''}">`);
    expect(page).toContain(`<a href="${folder}SHA256SUMS">SHA256SUMS</a>`);
    expect(page).toContain('<code>SHA-256 hash7</code>');
    // Commands are escaped: the shell quotes and pipe survive as text.
    expect(page).toContain(`echo &#39;hash4  ${names.deb}&#39; | sha256sum -c`);
    expect(page.match(/<details>/g)).toHaveLength(8);
  });
});

describe('uploadPlan', () => {
  it('uploads immutable versioned files before the no-cache files that point at them', () => {
    const plan = uploadPlan(version, 'downloads');
    expect(plan.map((u) => u.key)).toEqual([
      `downloads/${version}/${names.windows}`,
      `downloads/${version}/${names.windowsZip}`,
      `downloads/${version}/${names.windowsPortable}`,
      `downloads/${version}/${names.appImage}`,
      `downloads/${version}/${names.deb}`,
      `downloads/${version}/${names.android}`,
      `downloads/${version}/${names.windows}.blockmap`,
      `downloads/${version}/newses-${version}-desktop.cdx.json`,
      `downloads/${version}/newses-${version}-mobile.cdx.json`,
      `downloads/${version}/SHA256SUMS`,
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
    expect(plan.find((u) => u.name === sboms[0])).toEqual(
      expect.objectContaining({ contentType: 'application/vnd.cyclonedx+json', attachment: false }),
    );
    expect(plan.find((u) => u.name === 'SHA256SUMS')).toEqual(
      expect.objectContaining({ contentType: 'text/plain; charset=utf-8', attachment: false }),
    );
    expect(plan.find((u) => u.name === 'latest.yml')).toEqual(
      expect.objectContaining({ contentType: 'text/yaml', cacheControl: 'no-cache' }),
    );
  });
});
