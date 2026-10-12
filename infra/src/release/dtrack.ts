// Dependency-Track projects for the deliverables' SBOMs (upload-sbom.ts uploads them): one project
// per deliverable, a version per release, tagged with where the version runs.
import { versionFromTag } from '@rss-reader/shared/release';
import type { Deliverable } from './sbom.ts';

/** Release tags go to prod, prerelease tags to dev; untagged builds are local. */
export const releaseKind = (tag: string | undefined) =>
  !tag ? 'local' : tag.includes('-') ? 'dev' : 'prod';

export interface UploadTarget {
  projectName: string;
  projectVersion: string;
  tags: string[];
  isLatest: boolean;
}

/**
 * A tagged build is that release's version; an untagged one is its branch's, which each
 * upload replaces.
 */
export function uploadTarget(
  deliverable: Deliverable,
  source: { tag?: string; branch?: string },
): UploadTarget {
  if (!source.tag && !source.branch) throw new Error('An upload needs a tag or a branch');
  return {
    projectName: `rss-reader-${deliverable}`,
    projectVersion: source.tag ? versionFromTag(source.tag).name : (source.branch ?? ''),
    tags: ['rss-reader', releaseKind(source.tag)],
    isLatest: Boolean(source.tag),
  };
}

/** The body of `PUT /api/v1/bom`, which creates the project version on first upload. */
export const bomUploadRequest = (target: UploadTarget, bom: string) => ({
  projectName: target.projectName,
  projectVersion: target.projectVersion,
  projectTags: target.tags.map((name) => ({ name })),
  autoCreate: true,
  isLatest: target.isLatest,
  bom: Buffer.from(bom).toString('base64'),
});
