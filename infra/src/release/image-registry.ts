// Joins and tags the release's server image in ECR Public (publish-image.ts runs it), through the
// AWS CLI, buildx, and cosign as `Run` calls them. A version's tag never moves: joining it again
// must join the same images.
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { imageRepositoryName, planTags } from './image.ts';

/**
 * Runs a command, returning its output, and throws when it fails. One that is not `quiet` writes
 * its output to stderr instead, as `join` prints only the reference.
 */
export type Run = (command: string, args: string[], quiet?: boolean) => string;

export interface PublishImage {
  run: Run;
  /** `public.ecr.aws/<alias>/<name>`. */
  repository: string;
  /** The version's tag: `1.2.3`, `1.2.3-rc.1`. */
  version: string;
  /** cosign's signing key, `awskms:///<key alias ARN>`. */
  key: string;
  /** The image legs' digests, one per architecture. */
  legs: string[];
  /** Pushes nothing: `join` gives the reference the image would have, `tag` the plan. */
  dryRun: boolean;
  /** Progress, to stderr for `join`. */
  log: (line: string) => void;
  /** Waits between verification attempts. */
  wait?: (ms: number) => Promise<unknown>;
}

export const VERIFY_ATTEMPTS = 7;
export const VERIFY_DELAY_MS = 10_000;

export const digestOf = (manifest: string) =>
  `sha256:${createHash('sha256').update(manifest).digest('hex')}`;

/** cosign's tag for an image's signatures, in its legacy layout. */
export const signatureTag = (digest: string) => `${digest.replace(':', '-')}.sig`;

/** The repository's tags, images, and deletes, through the AWS CLI and buildx. */
function registry({ run, repository }: Pick<PublishImage, 'run' | 'repository'>) {
  const name = imageRepositoryName(repository);
  // ECR Public serves only from us-east-1.
  const ecr = (...args: string[]) =>
    JSON.parse(
      run('aws', ['ecr-public', '--region', 'us-east-1', '--output', 'json', ...args]),
    ) as unknown;
  return {
    /** The repository's tags and the digest each points at. */
    tags() {
      const { imageTagDetails } = ecr('describe-image-tags', '--repository-name', name) as {
        imageTagDetails: { imageTag: string; imageDetail: { imageDigest: string } }[];
      };
      return new Map(imageTagDetails.map((d) => [d.imageTag, d.imageDetail.imageDigest]));
    },
    /** An image's digest and, for a multi-arch image, its images' digests. */
    inspect(reference: string) {
      const raw = run('docker', ['buildx', 'imagetools', 'inspect', '--raw', reference]);
      const { manifests = [] } = JSON.parse(raw) as { manifests?: { digest: string }[] };
      return { digest: digestOf(raw), images: manifests.map((m) => m.digest) };
    },
    /** Deletes tags or images; one already gone is fine. */
    remove(ids: string[]) {
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
    },
  };
}

/** The repository's tags, and the digest of the version's image when it is already published. */
function published(options: PublishImage) {
  const { repository, version, legs } = options;
  const images = registry(options);
  const before = images.tags();
  const digest = before.get(version);
  if (digest) {
    const joined = images.inspect(`${repository}@${digest}`).images;
    if (joined.length !== legs.length || !legs.every((leg) => joined.includes(leg))) {
      throw new Error(
        `${repository}:${version} already holds other images, and version tags never move: ` +
          'retry the publish leg alone, with the build legs’ images, or release a new version',
      );
    }
  }
  return { images, before, digest };
}

/**
 * Joins the image legs under the version's tag, signs the image once (the signature goes to Rekor
 * and under the tag sha256-<digest>.sig, which cosign 2 and 3 both verify), and verifies it.
 * Returns the image's reference, which the published compose file pins.
 */
export async function joinImage(options: PublishImage): Promise<string> {
  const { run, repository, version, key, legs, dryRun, log, wait = sleep } = options;
  const { images, digest: existing } = published(options);
  const ref = `${repository}:${version}`;
  const sources = legs.map((leg) => `${repository}@${leg}`);
  let digest = existing;
  if (!digest && dryRun) {
    // What buildx would push, followed by a newline.
    const manifest = run('docker', ['buildx', 'imagetools', 'create', '--dry-run', ...sources]);
    digest = digestOf(manifest.replace(/\n$/, ''));
  } else if (!digest) {
    run('docker', ['buildx', 'imagetools', 'create', '-t', ref, ...sources], false);
    digest = images.inspect(ref).digest;
    if (images.tags().get(version) !== digest) throw new Error(`${ref} is not on ${digest}`);
  }
  log(`${dryRun ? 'Dry run: would join' : 'Joined'} ${ref}@${digest}`);
  const image = `${repository}@${digest}`;
  if (dryRun) {
    log(`Dry run: would sign ${image}`);
    return image;
  }
  if (!images.tags().has(signatureTag(digest))) {
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
  for (let attempt = 1; ; attempt++) {
    try {
      run('cosign', ['verify', '--key', key, image], false);
      return image;
    } catch (error) {
      if (attempt === VERIFY_ATTEMPTS) throw error;
      log(`Verifying again in ${String(VERIFY_DELAY_MS / 1000)} s`);
      await wait(VERIFY_DELAY_MS);
    }
  }
}

/**
 * Moves the tags image.ts plans to the version's image, then deletes the superseded prereleases
 * with their images and signatures, as ECR Public has no lifecycle rules. A dry run gives the plan
 * and deletes the legs' images when the version is not published, as nothing tags them.
 */
export function tagImage(options: PublishImage): void {
  const { run, repository, version, legs, dryRun, log } = options;
  const { images, before, digest: existing } = published(options);
  const ref = (tag: string) => `${repository}:${tag}`;
  const plan = planTags(version, [...before.keys()]);
  if (dryRun) {
    log(`Dry run: would tag ${repository} with ${plan.floating.join(', ') || 'no floating tags'}`);
    log(`Dry run: would delete ${plan.superseded.join(', ') || 'no superseded prereleases'}`);
    if (!existing) {
      images.remove(legs.map((leg) => `imageDigest=${leg}`));
      log("Dry run: deleted the image legs' images");
    }
    return;
  }
  if (!existing) throw new Error(`${ref(version)} does not exist; join it first`);

  const image = images.inspect(`${repository}@${existing}`);
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
  const after = images.tags();
  const moved = [version, ...plan.floating].filter((tag) => after.get(tag) !== image.digest);
  if (moved.length > 0) throw new Error(`Not on ${image.digest}: ${moved.join(', ')}`);
  log(`Tagged ${repository}@${image.digest}: ${[version, ...plan.floating].join(', ')}`);

  // Superseded images and theirs, unless a tag still points at them.
  const kept = new Set(
    [...after].filter(([tag]) => !plan.superseded.includes(tag)).map(([, digest]) => digest),
  );
  const indexes = new Set<string>();
  const children = new Set<string>();
  for (const tag of plan.superseded) {
    const digest = after.get(tag);
    if (!digest || kept.has(digest)) continue;
    indexes.add(digest);
    for (const child of images.inspect(`${repository}@${digest}`).images) {
      if (!image.images.includes(child)) children.add(child);
    }
  }
  // Removing an image's last tag deletes it, as a rule; the images it joins go after it.
  images.remove(
    [...plan.superseded, ...[...indexes].map(signatureTag)]
      .filter((tag) => after.has(tag))
      .map((tag) => `imageTag=${tag}`),
  );
  images.remove([...indexes].map((digest) => `imageDigest=${digest}`));
  images.remove([...children].map((digest) => `imageDigest=${digest}`));
  if (plan.superseded.length > 0) log(`Deleted ${plan.superseded.join(', ')}`);
}
