// Publishes a release prepared by publish.ts into a directory instead of the downloads bucket: the
// Docker apps build's, which the server serves at /downloads/ (DOWNLOADS_DIR).
//   node infra/src/release/publish-local.ts --dir artifacts --to /downloads
// Versioned files go first and the root files (feeds, latest.json, index.html) last, each written
// beside its place and renamed into it, so no client reads a feed that points at a missing file.
// The prerelease it replaces is then deleted, as the bucket's lifecycle rule expires it on AWS.
import { copyFile, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { type ReleaseManifest, versionFromTag } from '@newses/shared/release';
import { DOWNLOADS_PREFIX } from '../config.ts';

/** The version and kind of the release `to` serves, if any. */
async function served(to: string): Promise<Pick<ReleaseManifest, 'version' | 'prerelease'> | null> {
  try {
    const { version, prerelease } = JSON.parse(
      await readFile(join(to, 'latest.json'), 'utf8'),
    ) as Partial<ReleaseManifest>;
    if (typeof version !== 'string' || typeof prerelease !== 'boolean') return null;
    // A folder name the delete may use: a release version, nothing else.
    versionFromTag(version);
    return { version, prerelease };
  } catch {
    return null;
  }
}

/** Applies `dir`'s plan.tsv to `to`; returns the version published and the prerelease deleted. */
export async function publishLocal(dir: string, to: string) {
  const plan = (await readFile(join(dir, 'plan.tsv'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [file = '', key = ''] = line.split('\t');
      if (!key.startsWith(`${DOWNLOADS_PREFIX}/`)) throw new Error(`Not a downloads key: ${key}`);
      return { file, path: key.slice(DOWNLOADS_PREFIX.length + 1) };
    });
  const manifest = JSON.parse(await readFile(join(dir, 'latest.json'), 'utf8')) as ReleaseManifest;
  const previous = await served(to);

  // The plan lists the versioned files first.
  for (const { file, path } of plan) {
    const target = join(to, path);
    await mkdir(dirname(target), { recursive: true });
    const partial = `${target}.partial`;
    await copyFile(file, partial);
    await rename(partial, target);
  }

  const replaced =
    previous?.prerelease && previous.version !== manifest.version ? previous.version : null;
  if (replaced) await rm(join(to, replaced), { recursive: true, force: true });
  return { version: manifest.version, replaced };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { dir: { type: 'string' }, to: { type: 'string' } } });
  if (!values.dir || !values.to) throw new Error('Usage: publish-local.ts --dir DIR --to DIR');
  const { version, replaced } = await publishLocal(values.dir, values.to);
  if (replaced) console.log(`Deleted the prerelease it replaced, ${replaced}`);
  console.log(`Published ${version} to ${values.to}`);
}
