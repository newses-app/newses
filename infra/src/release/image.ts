// The server image a release publishes: each image leg (infra/buildspec/release-image.yml) pushes
// one architecture by digest and hands the digest over, and the publish leg (publish-image.ts)
// joins them into one multi-arch image and tags it.

export const IMAGE_ARCHES = ['amd64', 'arm64'] as const;
export type ImageArch = (typeof IMAGE_ARCHES)[number];

/** The file an image leg hands its digest over in, under `releases/<tag>/`. */
export const imageDigestName = (arch: ImageArch) => `image-${arch}.digest`;

/** An ECR Public repository's name: its URI without `public.ecr.aws/<alias>/`. */
export const imageRepositoryName = (uri: string) => uri.split('/').slice(2).join('/');

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** A handed-over digest file's digest. */
export function parseDigest(text: string) {
  const digest = text.trim();
  if (!DIGEST.test(digest)) throw new Error(`Not an image digest: ${digest.slice(0, 80)}`);
  return digest;
}

const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;
const PRERELEASE = /^\d+\.\d+\.\d+-/;

const parts = (tag: string) => RELEASE.exec(tag)?.slice(1, 4).map(Number);

/** Whether release `a` sorts at or after release `b`. */
const atOrAfter = (a: number[], b: number[]) => {
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
};

export interface TagPlan {
  /** The version's own tag, which never moves. */
  version: string;
  /** Tags moved to the version's image. */
  floating: string[];
  /** Prerelease tags to delete, with their images. */
  superseded: string[];
}

/**
 * The tags a version gets, given the repository's tags. A release moves `X.Y`, `X`, and `latest`
 * when it is the newest release each covers, so a patch to an older line moves only that line's
 * tags. A prerelease moves `next` and supersedes every other prerelease, as the downloads keep
 * only the latest one.
 */
export function planTags(version: string, existing: string[]): TagPlan {
  if (PRERELEASE.test(version)) {
    return {
      version,
      floating: ['next'],
      superseded: existing.filter((tag) => PRERELEASE.test(tag) && tag !== version),
    };
  }
  const own = parts(version);
  if (!own) throw new Error(`Not a version: ${version}`);
  const releases = existing.flatMap((tag) => {
    const release = parts(tag);
    return release ? [release] : [];
  });
  const newestOf = (covers: (release: number[]) => boolean) =>
    releases.filter(covers).every((release) => atOrAfter(own, release));
  const [major, minor] = own;
  const floating = [
    ...(newestOf((r) => r[0] === major && r[1] === minor)
      ? [`${String(major)}.${String(minor)}`]
      : []),
    ...(newestOf((r) => r[0] === major) ? [String(major)] : []),
    ...(newestOf(() => true) ? ['latest'] : []),
  ];
  return { version, floating, superseded: [] };
}
