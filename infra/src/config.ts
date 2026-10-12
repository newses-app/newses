import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Server build reported to apps: the commit CodeBuild synthesises, else `dev`. */
export const BUILD_VERSION = process.env.CODEBUILD_RESOLVED_SOURCE_VERSION?.slice(0, 7) ?? 'dev';

/** A stage of the AWS deployment, from the deployment config. */
export interface StageConfig {
  name: 'dev' | 'prod';
  /** Branch whose pushes deploy this stage. */
  branch: string;
  /** Tags that release the apps to this stage, as CodePipeline trigger globs. */
  releaseTags: { tagsIncludes: string[]; tagsExcludes?: string[] };
  domainName: string;
  /** Production keeps its data when stacks are deleted. */
  retainData: boolean;
  backupDays: number;
  /** Log every compatibility-API call (credentials redacted) to capture client behaviour. */
  compatTrace: boolean;
  /** Purge writes entries to the cold-storage archive before deleting them. */
  archive: boolean;
  /** Share of Lambda invocations traced to X-Ray, 0 to 1; 0 leaves the tracing layer off. */
  traceSampling: number;
}

/** Where the app downloads live, in the downloads bucket and under the stage's domain. */
export const DOWNLOADS_PREFIX = 'downloads';
