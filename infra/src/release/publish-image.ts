// Publishes the release's server image (infra/buildspec/release-publish.yml), after the downloads:
// joins the image legs' digests under the version's tag, moves the tags image.ts plans to it,
// then deletes the superseded prereleases with their images, as ECR Public has no lifecycle
// rules. A version's tag never moves: publishing it again must join the same images.
// --dry-run prints the plan and deletes the legs' images instead, which nothing tags.
//   node infra/src/release/publish-image.ts --dir artifacts --tag v1.2.3 \
//     --repository public.ecr.aws/<alias>/newses [--dry-run]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { versionFromTag } from '@newses/shared/release';
import {
  IMAGE_ARCHES,
  imageDigestName,
  imageRepositoryName,
  parseDigest,
  planTags,
} from './image.ts';

const { values } = parseArgs({
  options: {
    dir: { type: 'string' },
    tag: { type: 'string' },
    repository: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});
if (!values.dir || !values.tag || !values.repository) {
  throw new Error('Usage: publish-image.ts --dir DIR --tag TAG --repository URI [--dry-run]');
}
const { dir, repository } = values;
const version = versionFromTag(values.tag).name;
const name = imageRepositoryName(repository);

function run(command: string, args: string[], quiet = true) {
  const result = spawnSync(command, args, {
    stdio: ['ignore', quiet ? 'pipe' : 'inherit', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
  return result.stdout;
}

// ECR Public serves only from us-east-1.
const ecr = (...args: string[]) =>
  JSON.parse(
    run('aws', ['ecr-public', '--region', 'us-east-1', '--output', 'json', ...args]),
  ) as unknown;

/** The repository's tags and the digest each points at. */
function tags() {
  const { imageTagDetails } = ecr('describe-image-tags', '--repository-name', name) as {
    imageTagDetails: { imageTag: string; imageDetail: { imageDigest: string } }[];
  };
  return new Map(imageTagDetails.map((d) => [d.imageTag, d.imageDetail.imageDigest]));
}

/** An image's digest and, for a multi-arch image, its images' digests. */
function inspect(reference: string) {
  const raw = run('docker', ['buildx', 'imagetools', 'inspect', '--raw', reference]);
  const { manifests = [] } = JSON.parse(raw) as { manifests?: { digest: string }[] };
  return {
    digest: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
    images: manifests.map((m) => m.digest),
  };
}

/** Deletes tags or images; one already gone is fine. */
function remove(ids: string[]) {
  if (ids.length === 0) return;
  const { failures = [] } = ecr(
    'batch-delete-image',
    '--repository-name',
    name,
    '--image-ids',
    ...ids,
  ) as { failures?: { failureCode: string; failureReason: string }[] };
  const failed = failures.filter((f) => f.failureCode !== 'ImageNotFound');
  if (failed.length > 0) {
    throw new Error(`Cannot delete: ${failed.map((f) => f.failureReason).join('; ')}`);
  }
}

const legs = await Promise.all(
  IMAGE_ARCHES.map(async (arch) =>
    parseDigest(await readFile(join(dir, imageDigestName(arch)), 'utf8')),
  ),
);
const before = tags();
const plan = planTags(version, [...before.keys()]);
const published = before.get(version);
if (published) {
  const { images } = inspect(`${repository}@${published}`);
  if (images.length !== legs.length || !legs.every((digest) => images.includes(digest))) {
    throw new Error(`${repository}:${version} already holds other images; version tags never move`);
  }
}

if (values['dry-run']) {
  console.log(`Dry run: would tag ${repository} with ${[version, ...plan.floating].join(', ')}`);
  console.log(`Dry run: would delete ${plan.superseded.join(', ') || 'no superseded prereleases'}`);
  if (!published) {
    remove(legs.map((digest) => `imageDigest=${digest}`));
    console.log("Dry run: deleted the image legs' images");
  }
  process.exit(0);
}

const ref = (tag: string) => `${repository}:${tag}`;
if (!published) {
  run(
    'docker',
    [
      'buildx',
      'imagetools',
      'create',
      '-t',
      ref(version),
      ...legs.map((digest) => `${repository}@${digest}`),
    ],
    false,
  );
}
const image = inspect(ref(version));
if (plan.floating.length > 0) {
  // From one multi-arch image, buildx pushes the same manifest: the digest stays the same.
  run(
    'docker',
    [
      'buildx',
      'imagetools',
      'create',
      ...plan.floating.flatMap((tag) => ['-t', ref(tag)]),
      `${repository}@${image.digest}`,
    ],
    false,
  );
}
const after = tags();
const moved = [version, ...plan.floating].filter((tag) => after.get(tag) !== image.digest);
if (moved.length > 0) throw new Error(`Not on ${image.digest}: ${moved.join(', ')}`);
console.log(`Tagged ${repository}@${image.digest}: ${[version, ...plan.floating].join(', ')}`);

// Superseded images and theirs, unless a tag still points at them.
const kept = new Set(
  [...after].filter(([tag]) => !plan.superseded.includes(tag)).map(([, digest]) => digest),
);
const indexes = new Set<string>();
const images = new Set<string>();
for (const tag of plan.superseded) {
  const digest = after.get(tag);
  if (!digest || kept.has(digest)) continue;
  indexes.add(digest);
  for (const child of inspect(`${repository}@${digest}`).images) {
    if (!image.images.includes(child)) images.add(child);
  }
}
// Removing an image's last tag deletes it, as a rule; the images it joins go after it.
remove(plan.superseded.map((tag) => `imageTag=${tag}`));
remove([...indexes].map((digest) => `imageDigest=${digest}`));
remove([...images].map((digest) => `imageDigest=${digest}`));
if (plan.superseded.length > 0) console.log(`Deleted ${plan.superseded.join(', ')}`);
