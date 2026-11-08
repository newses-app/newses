import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildManifest,
  checkBuiltFiles,
  FEEDS,
  imageDigestNames,
  installCommands,
  installerNames,
  openapiFile,
  openapiName,
  renderChecksums,
  renderCompose,
  renderIndex,
  rewriteFeed,
  sbomArtifacts,
  sbomFiles,
  sbomNames,
  serverCommands,
  serverNames,
  uploadPlan,
} from './manifest.ts';

const version = '1.2.3-rc.1';
const names = installerNames(version);
const sboms = sbomNames(version);
const openapi = openapiName(version);
const built = [...Object.values(names), `${names.windows}.blockmap`, ...sboms, openapi, ...FEEDS];
const imageSbom = `newses-${version}-image.cdx.json`;
const builtWithImage = [...built, imageSbom, 'image-amd64.digest', 'image-arm64.digest'];
const server = serverNames(version);
const repository = 'public.ecr.aws/example/newses';
const digest = `sha256:${'d'.repeat(64)}`;

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
  it("accepts exactly the version's installers, block map, SBOMs, OpenAPI document, and feeds", () => {
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
    expect(() => {
      checkBuiltFiles(
        version,
        built.filter((name) => name !== openapi),
      );
    }).toThrow(/missing \[newses-1\.2\.3-rc\.1-openapi\.json\]/);
  });

  it("takes the server image's SBOM and digests only when the stage publishes the image", () => {
    expect(() => {
      checkBuiltFiles(version, builtWithImage, true);
    }).not.toThrow();
    expect(() => {
      checkBuiltFiles(version, builtWithImage);
    }).toThrow(/unexpected \[newses-1\.2\.3-rc\.1-image\.cdx\.json, image-amd64\.digest/);
    expect(() => {
      checkBuiltFiles(
        version,
        builtWithImage.filter((name) => name !== 'image-arm64.digest'),
        true,
      );
    }).toThrow(/missing \[image-arm64\.digest\]/);
    expect(imageDigestNames(false)).toEqual([]);
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
const withServer = {
  ...input,
  files: [
    ...files,
    { name: imageSbom, size: 1, sha256: 'imagehash' },
    ...Object.entries(server).map(([key, name], i) => ({ name, size: 100 + i, sha256: key })),
  ],
  image: { repository, digest },
};

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

  it("adds the server image's, which describes no installer", () => {
    expect(sbomArtifacts(version, true).at(-1)).toEqual({ name: imageSbom, describes: [] });
  });
});

describe('renderChecksums', () => {
  it("lists the build legs' versioned files, in sha256sum's format", () => {
    const lines = renderChecksums(version, files).trimEnd().split('\n');
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe(`hash0  ${names.windows}`);
    expect(lines.some((line) => line.endsWith('latest.yml'))).toBe(false);
    expect(lines.at(-2)).toBe(`hash8  ${sboms[1] ?? ''}`);
    expect(lines.at(-1)).toBe(`hash9  ${openapi}`);
  });

  it('refuses a missing file', () => {
    expect(() => renderChecksums(version, files.slice(1))).toThrow(/Missing/);
  });

  it("lists the server image's SBOM and the server's files, but not the digests", () => {
    const withImage = [...builtWithImage, ...Object.values(server)].map((name, i) => ({
      name,
      size: i,
      sha256: `hash${String(i)}`,
    }));
    const lines = renderChecksums(version, withImage, true).trimEnd().split('\n');
    expect(lines).toHaveLength(15);
    expect(lines).toContain(`hash12  ${imageSbom}`);
    expect(lines.slice(-4)).toEqual([
      `hash15  ${server.compose}`,
      `hash16  ${server.env}`,
      `hash17  ${server.nginxProxy}`,
      `hash18  ${server.publicKey}`,
    ]);
    expect(lines.some((line) => line.endsWith('.digest'))).toBe(false);
  });

  it('refuses a missing server file when the stage publishes the image', () => {
    const withImage = builtWithImage.map((name, i) => ({ name, size: i, sha256: 'h' }));
    expect(() => renderChecksums(version, withImage, true)).toThrow(/Missing .*compose\.yaml/);
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

  it('only downloads and checks an SBOM or the OpenAPI document', () => {
    expect(installCommands('file', file)).toHaveLength(2);
  });
});

describe('renderCompose', () => {
  const pinned = `${repository}:${version}@${digest}`;
  const source = readFileSync(new URL('../../../docker/compose.yaml', import.meta.url), 'utf8');

  it("pins docker/compose.yaml's image and drops its build, keeping its comments", () => {
    const compose = renderCompose(source, pinned);
    expect(compose).toContain(`image: \${NEWSES_IMAGE:-${pinned}}\n`);
    expect(compose).not.toMatch(/build:|dockerfile:|context:/);
    expect(compose).toContain('# Nightly pg_dump.');
    expect(compose).not.toContain('newses:latest');
    expect(source.split('\n').length - compose.split('\n').length).toBe(3);
  });

  it('refuses a compose file that names the image other than once, or mounts host files', () => {
    expect(() => renderCompose('services: {}\n', pinned)).toThrow(/other than once/);
    const mounted = `${source}\n  extra:\n    volumes:\n      - ./data:/data\n`;
    expect(() => renderCompose(mounted, pinned)).toThrow(/host files/);
    const built = source.replace(
      '  restart: unless-stopped\n',
      '  restart: unless-stopped\n  x:\n    build: .\n',
    );
    expect(() => renderCompose(built, pinned)).toThrow(/builds/);
  });
});

describe('serverCommands', () => {
  const file = (name: string, sha256: string) => ({ url: `${folder}${name}`, size: 1, sha256 });
  const commands = serverCommands({
    image: { repository, tag: version, digest },
    compose: file(server.compose, 'c1'),
    env: file(server.env, 'e1'),
    nginxProxy: file(server.nginxProxy, 'n1'),
    publicKey: file(server.publicKey, 'p1'),
  });

  it('saves each file under the name Compose looks for, and checks it', () => {
    expect(commands.compose).toEqual([
      'mkdir newses && cd newses',
      `curl -fL -o compose.yaml ${folder}${server.compose}`,
      "echo 'c1  compose.yaml' | sha256sum -c",
      `curl -fL -o .env ${folder}${server.env}`,
      "echo 'e1  .env' | sha256sum -c",
      '# In .env, change POSTGRES_PASSWORD and set APP_SECRET to: openssl rand -base64 48',
      'docker compose up -d',
    ]);
    expect(commands.env).toEqual([
      `curl -fL -o .env.example ${folder}${server.env}`,
      "echo 'e1  .env.example' | sha256sum -c",
    ]);
    expect(commands.nginxProxy.at(-1)).toBe(
      'docker compose -f compose.yaml -f compose.nginx-proxy.yaml up -d',
    );
  });

  it("verifies the image's signature by tag with the signing key", () => {
    expect(commands.publicKey).toEqual([
      `curl -fL -o cosign.pub ${folder}${server.publicKey}`,
      "echo 'p1  cosign.pub' | sha256sum -c",
      `cosign verify --key cosign.pub ${repository}:${version}`,
    ]);
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

  it('adds the server image and its files when the stage publishes the image', () => {
    expect(buildManifest(input).server).toBeUndefined();
    const manifest = buildManifest({ ...withServer, image: { repository, digest } });
    expect(manifest.server).toEqual({
      image: { repository, tag: version, digest },
      compose: { url: `${folder}${server.compose}`, size: 100, sha256: 'compose' },
      env: { url: `${folder}${server.env}`, size: 101, sha256: 'env' },
      nginxProxy: { url: `${folder}${server.nginxProxy}`, size: 102, sha256: 'nginxProxy' },
      publicKey: { url: `${folder}${server.publicKey}`, size: 103, sha256: 'publicKey' },
    });
  });
});

describe('renderIndex', () => {
  const manifest = buildManifest(input);
  const page = renderIndex(manifest, sbomFiles(input), openapiFile(input));

  it('links each installer, SBOM, and the OpenAPI document with its hash and commands', () => {
    expect(page).toContain(`<a href="${manifest.windows.zip.url}">`);
    expect(page).toContain(`<a href="${manifest.windows.portable.url}">`);
    expect(page).toContain(`<a href="${manifest.android.url}">`);
    expect(page).toContain(`<a href="${folder}${sboms[1] ?? ''}">`);
    expect(page).toContain(`<a href="${folder}${openapi}">`);
    expect(page).toContain('<code>SHA-256 hash9</code>');
    expect(page).toContain(`<a href="${folder}SHA256SUMS">SHA256SUMS</a>`);
    expect(page).toContain('<code>SHA-256 hash7</code>');
    // Commands are escaped: the shell quotes and pipe survive as text.
    expect(page).toContain(`echo &#39;hash4  ${names.deb}&#39; | sha256sum -c`);
    expect(page.match(/<details>/g)).toHaveLength(9);
    expect(page).not.toContain('Server image SBOM');
  });

  it('has no Server section when the stage does not publish the image', () => {
    expect(page).not.toContain('<h2>Server</h2>');
  });

  it("adds the Server section and the image's SBOM when the stage publishes the image", () => {
    const serverManifest = buildManifest(withServer);
    const imagePage = renderIndex(serverManifest, sbomFiles(withServer), openapiFile(withServer));
    expect(imagePage).toContain('<h2>Server image SBOM</h2>');
    expect(imagePage).toContain(`<a href="${folder}${imageSbom}">`);
    expect(imagePage).toContain('<h2>Server</h2>');
    expect(imagePage).toContain(`<a href="${folder}${server.compose}">`);
    expect(imagePage).toContain(`<a href="${folder}${server.nginxProxy}">`);
    expect(imagePage).toContain(
      `docker pull ${repository}:${version}\ndocker pull ${repository}@${digest}`,
    );
    expect(imagePage).toContain('echo &#39;compose  compose.yaml&#39; | sha256sum -c');
    expect(imagePage).toContain(`cosign verify --key cosign.pub ${repository}:${version}`);
    // The server's four files and the image, then the image SBOM.
    expect(imagePage.match(/<details>/g)).toHaveLength(15);
    expect(imagePage.indexOf('<h2>Server</h2>')).toBeLessThan(imagePage.indexOf('Checksums'));
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
      `downloads/${version}/${openapi}`,
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
    expect(plan.find((u) => u.name === openapi)).toEqual(
      expect.objectContaining({
        contentType: 'application/vnd.oai.openapi+json',
        cacheControl: 'public, max-age=31536000, immutable',
        attachment: false,
      }),
    );
    expect(plan.find((u) => u.name === 'SHA256SUMS')).toEqual(
      expect.objectContaining({ contentType: 'text/plain; charset=utf-8', attachment: false }),
    );
    expect(plan.find((u) => u.name === 'latest.yml')).toEqual(
      expect.objectContaining({ contentType: 'text/yaml', cacheControl: 'no-cache' }),
    );
  });

  it("uploads the server image's SBOM and the server's files, but not the digests", () => {
    const plan = uploadPlan(version, 'downloads', true);
    const keys = plan.map((u) => u.key);
    expect(keys).toContain(`downloads/${version}/${imageSbom}`);
    expect(keys.indexOf(`downloads/${version}/${server.compose}`)).toBeLessThan(
      keys.indexOf('downloads/latest.json'),
    );
    expect(keys.some((key) => key.endsWith('.digest'))).toBe(false);
    expect(plan.find((u) => u.name === server.compose)).toEqual(
      expect.objectContaining({
        contentType: 'text/yaml',
        cacheControl: 'public, max-age=31536000, immutable',
        attachment: false,
      }),
    );
    for (const name of [server.env, server.publicKey]) {
      expect(plan.find((u) => u.name === name)).toEqual(
        expect.objectContaining({ contentType: 'text/plain; charset=utf-8', attachment: false }),
      );
    }
  });
});
