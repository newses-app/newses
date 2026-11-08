// Prepares a release for upload (infra/buildspec/release-publish.yml): checks the files the build
// legs handed over (with --image, the server image's too), names the installers in their SBOMs,
// adds the server's files from docker/ and the image's signing key (--public-key) with --image
// (publish-image.ts join's reference, which the compose file pins), writes SHA256SUMS, the feeds, latest.json and index.html beside them,
// and writes plan.tsv (file, key, content type, cache control, disposition) and urls.txt for the
// upload and the checks that follow.
//   node infra/src/release/publish.ts --dir artifacts --tag v1.2.3 --url https://host/downloads \
//     [--image public.ecr.aws/<alias>/newses@sha256:… --public-key cosign.pub]
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { versionFromTag } from '@newses/shared/release';
import { DOWNLOADS_PREFIX } from '../config.ts';
import {
  type BuiltFile,
  buildManifest,
  CHECKSUMS,
  checkBuiltFiles,
  FEEDS,
  imageDigestNames,
  openapiFile,
  renderChecksums,
  renderCompose,
  renderIndex,
  rewriteFeed,
  sbomArtifacts,
  sbomFiles,
  sbomNames,
  SERVER_FILES,
  type ServerImage,
  serverNames,
  uploadPlan,
} from './manifest.ts';
import { parseDigest } from './image.ts';
import { addDistributions, type Bom } from './sbom.ts';

const { values } = parseArgs({
  options: {
    dir: { type: 'string' },
    tag: { type: 'string' },
    url: { type: 'string' },
    prerelease: { type: 'boolean', default: false },
    image: { type: 'string' },
    'public-key': { type: 'string' },
  },
});
if (!values.dir || !values.tag || !values.url) {
  throw new Error(
    'Usage: publish.ts --dir DIR --tag TAG --url DOWNLOADS_URL [--prerelease] [--image REPOSITORY@DIGEST --public-key FILE]',
  );
}
if (Boolean(values.image) !== Boolean(values['public-key'])) {
  throw new Error('--image and --public-key go together');
}
const { dir, url } = values;
const baseUrl = url.replace(/\/$/, '');
const version = versionFromTag(values.tag);
const at = values.image?.lastIndexOf('@') ?? -1;
const serverImage: ServerImage | undefined = values.image
  ? { repository: values.image.slice(0, at), digest: parseDigest(values.image.slice(at + 1)) }
  : undefined;
const image = Boolean(serverImage);
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
checkBuiltFiles(version.name, names, image);
const built = async (name: string): Promise<BuiltFile> => {
  const path = join(dir, name);
  return { name, size: (await stat(path)).size, sha256: await sha256(path) };
};

// The SBOMs name the installers' hashes, so they are hashed after that; publish-image.ts reads
// the digests.
const sboms = sbomNames(version.name, image);
const handover = [...sboms, ...imageDigestNames(image)];
const installers = await Promise.all(names.filter((name) => !handover.includes(name)).map(built));
for (const { name, describes } of sbomArtifacts(version.name, image)) {
  const path = join(dir, name);
  const bom = JSON.parse(await readFile(path, 'utf8')) as Bom;
  const files = describes.map((described) => {
    const file = installers.find((f) => f.name === described);
    if (!file) throw new Error(`Missing ${described}`);
    return { url: `${baseUrl}/${version.name}/${described}`, sha256: file.sha256 };
  });
  await writeFile(path, `${JSON.stringify(addDistributions(bom, files), null, 2)}\n`);
}

// The server's files, the compose file pinned to the image, and the image's signing key.
const server: BuiltFile[] = [];
if (serverImage) {
  const names = serverNames(version.name);
  const pinned = `${serverImage.repository}:${version.name}@${serverImage.digest}`;
  for (const [file, source] of Object.entries(SERVER_FILES) as [keyof typeof names, string][]) {
    const path =
      file === 'publicKey'
        ? (values['public-key'] ?? '')
        : fileURLToPath(new URL(`../../../docker/${source}`, import.meta.url));
    const text = await readFile(path, 'utf8');
    await writeFile(
      join(dir, names[file]),
      file === 'compose' ? renderCompose(text, pinned) : text,
    );
    server.push(await built(names[file]));
  }
}
const files = [...installers, ...(await Promise.all(sboms.map(built))), ...server];
await writeFile(join(dir, CHECKSUMS), renderChecksums(version.name, files, image));

for (const feed of FEEDS) {
  const path = join(dir, feed);
  await writeFile(path, rewriteFeed(await readFile(path, 'utf8'), version.name));
}
const input = {
  version: version.name,
  versionCode: version.code,
  prerelease: values.prerelease,
  published: new Date(),
  baseUrl,
  files,
  image: serverImage,
};
const manifest = buildManifest(input);
await writeFile(join(dir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(
  join(dir, 'index.html'),
  renderIndex(manifest, sbomFiles(input), openapiFile(input)),
);

const plan = uploadPlan(version.name, DOWNLOADS_PREFIX, image);
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
