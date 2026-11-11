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
  /** What the apps call this server (`INSTANCE_NAME`); omitted for none. */
  instanceName?: string | undefined;
  /** Where the apps link this stage's source (`SOURCE_URL`); omitted for the repository at the commit. */
  sourceUrl?: string | undefined;
  /** The UnifiedPush distributor the Android app suggests to readers (`PUSH_DISTRIBUTOR_URL`). */
  pushDistributorUrl?: string | undefined;
  /**
   * Whether the functions read ntfy access tokens (`PUSH_TOKENS`) from the SecureString
   * `/<prefix>/<stage>/push-tokens`, which the operator creates.
   */
  pushTokens?: boolean | undefined;
  /** Origins whose pages may fetch the downloads (the project site's `latest.json` reads). */
  downloadsCorsOrigins?: string[] | undefined;
  /**
   * ECR Public repository the release pipeline publishes the server image to,
   * `public.ecr.aws/<alias>/<name>`; stages may share one. Omitted for no image.
   */
  imageRepository?: string | undefined;
}

/** Where the app downloads live, in the downloads bucket and under the stage's domain. */
export const DOWNLOADS_PREFIX = 'downloads';
