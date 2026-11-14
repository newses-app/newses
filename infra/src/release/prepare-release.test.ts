import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Platform } from '@newses/shared/release';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DOWNLOADS_PREFIX } from '../config.ts';
import { imageDigestName } from './image.ts';
import { installerNames, openapiName, sbomNames, serverNames } from './manifest.ts';
import { parsePlatforms, prepareRelease, type ReleaseOptions } from './prepare-release.ts';
import type { Bom } from './sbom.ts';

const URL = 'https://downloads.example/downloads';
const REPOSITORY = 'public.ecr.aws/newses/newses';
const DIGEST = `sha256:${'b2'.repeat(32)}`;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'prepare-release-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(`${dir}.pub`, { force: true });
});

/** What the build legs hand over for `version`: each installer's content is its name. */
async function handOver(version: string, platforms: Platform[], image = false) {
  const names = installerNames(version);
  const installers = [
    ...(platforms.includes('linux') ? [names.appImage, names.deb] : []),
    ...(platforms.includes('android') ? [names.android] : []),
  ];
  for (const name of [...installers, openapiName(version)]) await writeFile(join(dir, name), name);
  const bom: Bom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    metadata: { component: { type: 'application', name: 'newses' } },
  };
  for (const name of sbomNames(version, image, platforms))
    await writeFile(join(dir, name), JSON.stringify(bom));
  if (platforms.includes('linux')) {
    await writeFile(
      join(dir, 'latest-linux.yml'),
      `version: ${version}\nfiles:\n  - url: ${names.appImage}\n    sha512: abc==\npath: ${names.appImage}\n`,
    );
  }
  if (image) {
    for (const arch of ['amd64', 'arm64'] as const)
      await writeFile(
        join(dir, imageDigestName(arch)),
        `sha256:${arch === 'amd64' ? 'a1' : 'c3'}`.padEnd(71, '0'),
      );
    await writeFile(`${dir}.pub`, '-----BEGIN PUBLIC KEY-----\n');
  }
  return names;
}

const options = (tag: string, overrides: Partial<ReleaseOptions> = {}): ReleaseOptions => ({
  dir,
  tag,
  url: `${URL}/`,
  prerelease: tag.includes('-'),
  platforms: 'linux,android',
  published: new Date('2026-11-14T12:00:00Z'),
  ...overrides,
});

const read = (name: string) => readFile(join(dir, name), 'utf8');

describe('prepareRelease', () => {
  it("names the installers in their SBOMs, and writes the release's checksums, feeds, and plan", async () => {
    const names = await handOver('1.2.3', ['linux', 'android']);
    const manifest = await prepareRelease(options('v1.2.3'));

    const desktop = JSON.parse(await read('newses-1.2.3-desktop.cdx.json')) as Bom;
    expect(desktop.metadata?.component?.externalReferences).toEqual(
      [names.appImage, names.deb].map((name) => ({
        type: 'distribution',
        url: `${URL}/1.2.3/${name}`,
        hashes: [{ alg: 'SHA-256', content: sha256(name) }],
      })),
    );
    expect(await read('SHA256SUMS')).toContain(`${sha256(names.android)}  ${names.android}\n`);
    expect(await read('latest-linux.yml')).toContain(`path: 1.2.3/${names.appImage}\n`);
    expect(JSON.parse(await read('latest.json'))).toEqual(JSON.parse(JSON.stringify(manifest)));
    expect(manifest).toMatchObject({ version: '1.2.3', prerelease: false });
    expect(await read('index.html')).toContain(names.android);

    const plan = (await read('plan.tsv'))
      .trimEnd()
      .split('\n')
      .map((line) => line.split('\t'));
    for (const [file, key] of plan) {
      expect(file?.startsWith(dir)).toBe(true);
      expect(key?.startsWith(`${DOWNLOADS_PREFIX}/`)).toBe(true);
    }
    expect(plan.find(([file]) => file?.endsWith(names.android))?.[4]).toBe('attachment');
    const urls = (await read('urls.txt')).trimEnd().split('\n');
    expect(urls).toHaveLength(plan.length + 1);
    expect(urls.at(-1)).toBe(`https://downloads.example/${DOWNLOADS_PREFIX}/`);
  });

  it("adds the server's files with the image, the compose file pinned to it", async () => {
    await handOver('1.2.3-rc.1', ['android'], true);
    const manifest = await prepareRelease(
      options('v1.2.3-rc.1', {
        platforms: 'android',
        image: `${REPOSITORY}@${DIGEST}`,
        publicKey: `${dir}.pub`,
      }),
    );
    const server = serverNames('1.2.3-rc.1');
    expect(await read(server.compose)).toContain(`${REPOSITORY}:1.2.3-rc.1@${DIGEST}`);
    expect(await read(server.publicKey)).toBe('-----BEGIN PUBLIC KEY-----\n');
    expect(await read('SHA256SUMS')).toContain(server.env);
    expect(manifest.server).toBeDefined();
    expect(await readdir(dir)).not.toContain('latest-linux.yml');
  });

  it('refuses files that do not match the release, or a tag of the wrong kind', async () => {
    await handOver('1.2.3', ['android']);
    await expect(prepareRelease(options('v1.2.3'))).rejects.toThrow(
      /files do not match: missing \[.*AppImage/,
    );
    await expect(
      prepareRelease(options('v1.2.3', { platforms: 'android', prerelease: true })),
    ).rejects.toThrow('v1.2.3 is the wrong kind of tag for this stage');
    await writeFile(join(dir, 'stale.apk'), '');
    await expect(prepareRelease(options('v1.2.3', { platforms: 'android' }))).rejects.toThrow(
      /unexpected \[stale\.apk\]/,
    );
  });

  it('needs the image and its signing key together', async () => {
    await expect(
      prepareRelease(options('v1.2.3', { image: `${REPOSITORY}@${DIGEST}` })),
    ).rejects.toThrow('--image and --public-key go together');
  });
});

describe('parsePlatforms', () => {
  it('takes some of the platforms, and nothing else', () => {
    expect(parsePlatforms('linux, android')).toEqual(['linux', 'android']);
    expect(() => parsePlatforms('linux,ios')).toThrow(/--platforms takes some of .*: linux,ios/);
  });
});
