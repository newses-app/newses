// Dependency-Track projects for the deliverables' SBOMs (upload-sbom.ts uploads them): one project
// per deliverable, a version per release, tagged with where the version runs.
import { setTimeout as sleep } from 'node:timers/promises';
import { versionFromTag } from '@newses/shared/release';
import { type Deliverable, parseSbomName } from './sbom.ts';

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
    projectName: `newses-${deliverable}`,
    projectVersion: source.tag ? versionFromTag(source.tag).name : (source.branch ?? ''),
    tags: ['newses', releaseKind(source.tag)],
    isLatest: Boolean(source.tag),
  };
}

/** The body of `PUT /api/v1/bom`, which creates the project version on first upload. */
export const bomUploadRequest = (target: UploadTarget, bom: string) => ({
  projectName: target.projectName,
  projectVersion: target.projectVersion,
  projectTags: target.tags.map((name) => ({ name })),
  autoCreate: true,
  isLatestProjectVersion: target.isLatest,
  bom: Buffer.from(bom).toString('base64'),
});

/**
 * The SBOMs among `names` (build-sbom.ts's file names) in `dir`, all of `tag`'s version (an
 * untagged build's, `0.0.0-dev`): files from another build would be uploaded under the wrong one.
 */
export function sbomsToUpload(dir: string, names: string[], tag: string | undefined) {
  const expected = versionFromTag(tag).name;
  const files = names.flatMap((name) => {
    const parsed = parseSbomName(name);
    return parsed ? [{ name, ...parsed }] : [];
  });
  if (files.length === 0) throw new Error(`No SBOMs in ${dir}`);
  const stale = files.filter((file) => file.version !== expected);
  if (stale.length > 0) {
    throw new Error(`Not ${expected}: ${stale.map((file) => file.name).join(', ')}`);
  }
  return files;
}

export type DtrackApi = (method: string, path: string, body?: unknown) => Promise<unknown>;

/** Calls Dependency-Track's API at `baseUrl` with `apiKey`; throws on an error status. */
export function dtrackApi(
  baseUrl: string,
  apiKey: string,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): DtrackApi {
  const root = baseUrl.replace(/\/$/, '');
  return async (method, path, body) => {
    const response = await fetch(`${root}${path}`, {
      method,
      headers: {
        'X-Api-Key': apiKey,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${method} ${path}: ${String(response.status)} ${text.slice(0, 500)}`);
    }
    return text ? (JSON.parse(text) as unknown) : undefined;
  };
}

/** How long an upload may take to process. */
export const PROCESSING_LIMIT_MS = 5 * 60_000;
const POLL_MS = 2000;

/** Uploads one SBOM to `target` and waits for Dependency-Track to process it. */
export async function uploadBom(
  api: DtrackApi,
  name: string,
  target: UploadTarget,
  bom: string,
  wait: (ms: number) => Promise<unknown> = sleep,
): Promise<void> {
  const { token } = (await api('PUT', '/api/v1/bom', bomUploadRequest(target, bom))) as {
    token: string;
  };
  const deadline = Date.now() + PROCESSING_LIMIT_MS;
  for (;;) {
    const status = (await api('GET', `/api/v1/event/token/${token}`)) as {
      processing: boolean;
      status?: string | null;
    };
    if (status.status === 'FAILED') throw new Error(`${name}: processing failed`);
    if (!status.processing) return;
    if (Date.now() > deadline) throw new Error(`${name}: still processing after 5 minutes`);
    await wait(POLL_MS);
  }
}
