// Publishes the release's server image (infra/buildspec/release-publish.yml) in two steps, in the
// order the downloads go. `join`, before the uploads, joins the image legs' digests under the
// version's tag, signs the image with cosign and --key (once; the signature goes to Rekor and
// under the tag sha256-<digest>.sig, which cosign 2 and 3 both verify), and prints the image's
// reference, which the published compose file pins. `tag`, after the URL check, moves the tags
// image.ts plans to it, then deletes the superseded prereleases with their images and signatures,
// as ECR Public has no lifecycle rules. A version's tag never moves: joining it again must join
// the same images.
// --dry-run pushes nothing: `join` prints the reference the image would have, and `tag` prints
// the plan and deletes the legs' images, which nothing tags.
//   node infra/src/release/publish-image.ts join|tag --dir artifacts --tag v1.2.3 \
//     --repository public.ecr.aws/<alias>/newses --key awskms:///<key alias ARN> [--dry-run]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { versionFromTag } from '@newses/shared/release';
import {
  IMAGE_ARCHES,
  imageDigestName,
  imageRepositoryName,
  parseDigest,
  planTags,
} from './image.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string' },
    tag: { type: 'string' },
    repository: { type: 'string' },
    key: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});
const [step] = positionals;
if (
  (step !== 'join' && step !== 'tag') ||
  !values.dir ||
  !values.tag ||
  !values.repository ||
  !values.key
) {
  throw new Error(
    'Usage: publish-image.ts join|tag --dir DIR --tag TAG --repository URI --key KEY [--dry-run]',
  );
}
const { dir, repository, key } = values;
const dryRun = values['dry-run'];
const version = versionFromTag(values.tag).name;
const name = imageRepositoryName(repository);

const VERIFY_ATTEMPTS = 7;
const VERIFY_DELAY_MS = 10_000;

// Commands that are not quiet write to stderr, as `join` prints only the reference.
function run(command: string, args: string[], quiet = true) {
  const result = spawnSync(command, args, {
    stdio: ['ignore', quiet ? 'pipe' : 2, 'inherit'],
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

const digestOf = (manifest: string) =>
  `sha256:${createHash('sha256').update(manifest).digest('hex')}`;

/** An image's digest and, for a multi-arch image, its images' digests. */
function inspect(reference: string) {
  const raw = run('docker', ['buildx', 'imagetools', 'inspect', '--raw', reference]);
  const { manifests = [] } = JSON.parse(raw) as { manifests?: { digest: string }[] };
  return {
    digest: digestOf(raw),
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
const published = before.get(version);
if (published) {
  const { images } = inspect(`${repository}@${published}`);
  if (images.length !== legs.length || !legs.every((digest) => images.includes(digest))) {
    throw new Error(
      `${repository}:${version} already holds other images, and version tags never move: ` +
        'retry the publish leg alone, with the build legs’ images, or release a new version',
    );
  }
}
const ref = (tag: string) => `${repository}:${tag}`;
/** cosign's tag for an image's signatures, in its legacy layout. */
const signatureTag = (digest: string) => `${digest.replace(':', '-')}.sig`;
const sources = legs.map((digest) => `${repository}@${digest}`);

if (step === 'join') {
  let digest = published;
  if (!digest && dryRun) {
    // What buildx would push, followed by a newline.
    const manifest = run('docker', ['buildx', 'imagetools', 'create', '--dry-run', ...sources]);
    digest = digestOf(manifest.replace(/\n$/, ''));
  } else if (!digest) {
    run('docker', ['buildx', 'imagetools', 'create', '-t', ref(version), ...sources], false);
    digest = inspect(ref(version)).digest;
    if (tags().get(version) !== digest) throw new Error(`${ref(version)} is not on ${digest}`);
  }
  console.error(`${dryRun ? 'Dry run: would join' : 'Joined'} ${ref(version)}@${digest}`);
  const image = `${repository}@${digest}`;
  if (dryRun) {
    console.error(`Dry run: would sign ${image}`);
  } else if (!tags().has(signatureTag(digest))) {
    run(
      'cosign',
      [
        'sign',
        '--yes',
        '--key',
        key,
        '--new-bundle-format=false',
        '--use-signing-config=false',
        image,
      ],
      false,
    );
  }
  // The registry can answer for a while with the signature tag's absence, which cosign looked up
  // before pushing it.
  for (let attempt = 1; !dryRun; attempt++) {
    try {
      run('cosign', ['verify', '--key', key, image], false);
      break;
    } catch (error) {
      if (attempt === VERIFY_ATTEMPTS) throw error;
      console.error(`Verifying again in ${String(VERIFY_DELAY_MS / 1000)} s`);
      await sleep(VERIFY_DELAY_MS);
    }
  }
  console.log(`${repository}@${digest}`);
  process.exit(0);
}

const plan = planTags(version, [...before.keys()]);
if (dryRun) {
  console.log(
    `Dry run: would tag ${repository} with ${plan.floating.join(', ') || 'no floating tags'}`,
  );
  console.log(`Dry run: would delete ${plan.superseded.join(', ') || 'no superseded prereleases'}`);
  if (!published) {
    remove(legs.map((digest) => `imageDigest=${digest}`));
    console.log("Dry run: deleted the image legs' images");
  }
  process.exit(0);
}
if (!published) throw new Error(`${ref(version)} does not exist; join it first`);

const image = inspect(`${repository}@${published}`);
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
remove(
  [...plan.superseded, ...[...indexes].map(signatureTag)]
    .filter((tag) => after.has(tag))
    .map((tag) => `imageTag=${tag}`),
);
remove([...indexes].map((digest) => `imageDigest=${digest}`));
remove([...images].map((digest) => `imageDigest=${digest}`));
if (plan.superseded.length > 0) console.log(`Deleted ${plan.superseded.join(', ')}`);
