// Prepares a release for upload (publish.ts runs it): checks the files the build legs handed over
// (with an image, the server image's too), names the installers in their SBOMs, adds the server's
// files from docker/ and the image's signing key with an image (publish-image.ts join's
// reference, which the compose file pins), writes SHA256SUMS, the feeds, latest.json and
// index.html beside them, and writes plan.tsv (file, key, content type, cache control,
// disposition) and urls.txt for the upload and the checks that follow.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Platform,
  PLATFORMS,
  type ReleaseManifest,
  versionFromTag,
} from '@newses/shared/release';
import { DOWNLOADS_PREFIX } from '../config.ts';
import { parseDigest } from './image.ts';
import {
  type BuiltFile,
  buildManifest,
  CHECKSUMS,
  checkBuiltFiles,
  feeds,
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
import { addDistributions, type Bom } from './sbom.ts';

export interface ReleaseOptions {
  /** The build legs' files, where the release's files are written too. */
  dir: string;
  tag: string;
  /** Where the downloads are served, `https://host/downloads`. */
  url: string;
  prerelease: boolean;
  /** The apps built: some of `PLATFORMS`, comma-separated. */
  platforms: string;
  /** The server image's `repository@digest`, with `publicKey`, the file of its signing key. */
  image?: string | undefined;
  publicKey?: string | undefined;
  /** Where the server's files are; the repository's docker/ by default. */
  dockerDir?: string;
  published?: Date;
}

/** The apps a release has, from their comma-separated names. */
export function parsePlatforms(list: string): Platform[] {
  const platforms = list.split(',').map((p) => p.trim()) as Platform[];
  const unknown = platforms.filter((p) => !PLATFORMS.includes(p));
  if (unknown.length > 0 || platforms.length === 0) {
    throw new Error(`--platforms takes some of ${PLATFORMS.join(', ')}: ${list}`);
  }
  return platforms;
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

/** Writes the release's files into `dir` and returns its manifest, latest.json. */
export async function prepareRelease(options: ReleaseOptions): Promise<ReleaseManifest> {
  const { dir, url } = options;
  if (Boolean(options.image) !== Boolean(options.publicKey)) {
    throw new Error('--image and --public-key go together');
  }
  const platforms = parsePlatforms(options.platforms);
  const baseUrl = url.replace(/\/$/, '');
  const version = versionFromTag(options.tag);
  const at = options.image?.lastIndexOf('@') ?? -1;
  const serverImage: ServerImage | undefined = options.image
    ? { repository: options.image.slice(0, at), digest: parseDigest(options.image.slice(at + 1)) }
    : undefined;
  const image = Boolean(serverImage);
  if (options.prerelease !== version.name.includes('-')) {
    throw new Error(`${options.tag} is the wrong kind of tag for this stage`);
  }

  const names = await readdir(dir);
  checkBuiltFiles(version.name, names, image, platforms);
  const built = async (name: string): Promise<BuiltFile> => {
    const path = join(dir, name);
    return { name, size: (await stat(path)).size, sha256: await sha256(path) };
  };

  // The SBOMs name the installers' hashes, so they are hashed after that; publish-image.ts reads
  // the digests.
  const sboms = sbomNames(version.name, image, platforms);
  const handover = [...sboms, ...imageDigestNames(image)];
  const installers = await Promise.all(names.filter((name) => !handover.includes(name)).map(built));
  for (const { name, describes } of sbomArtifacts(version.name, image, platforms)) {
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
    const docker = options.dockerDir ?? fileURLToPath(new URL('../../../docker/', import.meta.url));
    const files = serverNames(version.name);
    const pinned = `${serverImage.repository}:${version.name}@${serverImage.digest}`;
    for (const [file, source] of Object.entries(SERVER_FILES) as [keyof typeof files, string][]) {
      const path = file === 'publicKey' ? (options.publicKey ?? '') : join(docker, source);
      const text = await readFile(path, 'utf8');
      await writeFile(
        join(dir, files[file]),
        file === 'compose' ? renderCompose(text, pinned) : text,
      );
      server.push(await built(files[file]));
    }
  }
  const files = [...installers, ...(await Promise.all(sboms.map(built))), ...server];
  await writeFile(join(dir, CHECKSUMS), renderChecksums(version.name, files, image, platforms));

  for (const feed of feeds(platforms)) {
    const path = join(dir, feed);
    await writeFile(path, rewriteFeed(await readFile(path, 'utf8'), version.name));
  }
  const input = {
    version: version.name,
    versionCode: version.code,
    prerelease: options.prerelease,
    published: options.published ?? new Date(),
    baseUrl,
    files,
    image: serverImage,
    platforms,
  };
  const manifest = buildManifest(input);
  await writeFile(join(dir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(
    join(dir, 'index.html'),
    renderIndex(manifest, sbomFiles(input), openapiFile(input)),
  );

  const plan = uploadPlan(version.name, DOWNLOADS_PREFIX, image, platforms);
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
  return manifest;
}
