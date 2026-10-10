// Prepares a release for upload (infra/buildspec/release-publish.yml): checks the files the build
// legs handed over, writes the feeds, latest.json and index.html beside them, and writes
// plan.tsv (file, key, content type, cache control, disposition) and urls.txt for the upload
// and the checks that follow.
//   node infra/src/release/publish.ts --dir artifacts --tag v1.2.3 --url https://host/downloads
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { versionFromTag } from '@rss-reader/shared/release';
import { DOWNLOADS_PREFIX } from '../config.ts';
import {
  type BuiltFile,
  buildManifest,
  checkBuiltFiles,
  FEEDS,
  renderIndex,
  rewriteFeed,
  uploadPlan,
} from './manifest.ts';

const { values } = parseArgs({
  options: {
    dir: { type: 'string' },
    tag: { type: 'string' },
    url: { type: 'string' },
    prerelease: { type: 'boolean', default: false },
  },
});
if (!values.dir || !values.tag || !values.url) {
  throw new Error('Usage: publish.ts --dir DIR --tag TAG --url DOWNLOADS_URL [--prerelease]');
}
const { dir, url } = values;
const version = versionFromTag(values.tag);
if (values.prerelease !== version.name.includes('-')) {
  throw new Error(`${values.tag} is the wrong kind of tag for this stage`);
}

const sha256 = (path: string) =>
  new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => {
        resolve(hash.digest('hex'));
      })
      .on('error', reject);
  });

const names = await readdir(dir);
checkBuiltFiles(version.name, names);
const files: BuiltFile[] = await Promise.all(
  names.map(async (name) => {
    const path = join(dir, name);
    return { name, size: (await stat(path)).size, sha256: await sha256(path) };
  }),
);

for (const feed of FEEDS) {
  const path = join(dir, feed);
  await writeFile(path, rewriteFeed(await readFile(path, 'utf8'), version.name));
}
const manifest = buildManifest({
  version: version.name,
  versionCode: version.code,
  prerelease: values.prerelease,
  published: new Date(),
  baseUrl: url.replace(/\/$/, ''),
  files,
});
await writeFile(join(dir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(join(dir, 'index.html'), renderIndex(manifest));

const plan = uploadPlan(version.name, DOWNLOADS_PREFIX);
await writeFile(
  join(dir, 'plan.tsv'),
  plan
    .map((upload) =>
      [
        join(dir, upload.name),
        upload.key,
        upload.contentType,
        upload.cacheControl,
        upload.attachment ? 'attachment' : 'inline',
      ].join('\t'),
    )
    .join('\n') + '\n',
);
const host = new URL(url).origin;
await writeFile(
  join(dir, 'urls.txt'),
  [...plan.map((upload) => `${host}/${upload.key}`), `${host}/${DOWNLOADS_PREFIX}/`].join('\n') +
    '\n',
);
console.log(JSON.stringify(manifest, null, 2));
