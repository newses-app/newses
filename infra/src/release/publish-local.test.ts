import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { publishLocal } from './publish-local.ts';

let root: string;
let dir: string;
let to: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'publish-local-'));
  dir = join(root, 'artifacts');
  to = join(root, 'downloads');
  await mkdir(dir);
  await mkdir(to);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A prepared release in `dir`: its APK, feed, latest.json, and the plan that lists them. */
async function prepare(version: string, prerelease: boolean) {
  const files: [string, string, string][] = [
    [`newses-${version}-android.apk`, `downloads/${version}/newses-${version}-android.apk`, 'apk'],
    ['latest-linux.yml', 'downloads/latest-linux.yml', `version: ${version}\n`],
    ['latest.json', 'downloads/latest.json', JSON.stringify({ version, prerelease })],
  ];
  for (const [name, , content] of files) await writeFile(join(dir, name), content);
  await writeFile(
    join(dir, 'plan.tsv'),
    files
      .map(([name, key]) => [join(dir, name), key, 'type', 'no-cache', 'inline'].join('\t'))
      .join('\n') + '\n',
  );
}

/** What `to` serves: each file and its content. */
async function listing(path = to): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(to.length + 1))
    .sort();
}

describe('publishLocal', () => {
  it('writes the versioned files under their version and the rest at the root', async () => {
    await prepare('1.2.3', false);
    await expect(publishLocal(dir, to)).resolves.toEqual({ version: '1.2.3', replaced: null });
    expect(await listing()).toEqual([
      '1.2.3/newses-1.2.3-android.apk',
      'latest-linux.yml',
      'latest.json',
    ]);
    expect(await readFile(join(to, 'latest-linux.yml'), 'utf8')).toBe('version: 1.2.3\n');
  });

  it('deletes the prerelease it replaces, but keeps earlier releases', async () => {
    await prepare('1.2.3', false);
    await publishLocal(dir, to);
    await prepare('1.2.4-rc.1', true);
    await publishLocal(dir, to);
    await prepare('1.2.4', false);
    await expect(publishLocal(dir, to)).resolves.toEqual({
      version: '1.2.4',
      replaced: '1.2.4-rc.1',
    });
    expect(await listing()).toEqual([
      '1.2.3/newses-1.2.3-android.apk',
      '1.2.4/newses-1.2.4-android.apk',
      'latest-linux.yml',
      'latest.json',
    ]);
  });

  it('keeps the folder when publishing the same version again', async () => {
    await prepare('1.2.4-rc.1', true);
    await publishLocal(dir, to);
    await expect(publishLocal(dir, to)).resolves.toMatchObject({ replaced: null });
    expect(await listing()).toContain('1.2.4-rc.1/newses-1.2.4-rc.1-android.apk');
  });

  it('deletes nothing for a latest.json that names no release', async () => {
    await mkdir(join(to, 'keep'));
    await writeFile(join(to, 'keep/file'), '');
    await writeFile(join(to, 'latest.json'), JSON.stringify({ version: 'keep', prerelease: true }));
    await prepare('1.2.3', false);
    await expect(publishLocal(dir, to)).resolves.toMatchObject({ replaced: null });
    expect(await listing()).toContain('keep/file');
  });

  it('refuses a plan for somewhere other than the downloads', async () => {
    await writeFile(join(dir, 'plan.tsv'), `${join(dir, 'x')}\tother/x\ttype\tno-cache\tinline\n`);
    await expect(publishLocal(dir, to)).rejects.toThrow('Not a downloads key: other/x');
  });
});
