import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export const ACCOUNT = '123456789012';
export const REGION = 'us-east-2';
export const GITHUB_REPO = 'himynameschris/rss-reader';
export const GITHUB_CONNECTION_ARN =
  'arn:aws:codeconnections:us-east-2:123456789012:connection/00000000-0000-0000-0000-000000000000';
/** Covers example.com and *.example.com; CloudFront requires certificates from us-east-1. */
export const CERTIFICATE_ARN =
  'arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000';
export const HOSTED_ZONE = { zoneName: 'example.com', hostedZoneId: 'Z0000000000EXAMPLE' };

export const PROJECT = 'rss-reader';

/**
 * AWS Distro for OpenTelemetry (JavaScript) Lambda layer; ARNs are regional and versioned, listed at
 * https://aws-otel.github.io/docs/getting-started/lambda.
 */
export const ADOT_LAYER_ARN =
  'arn:aws:lambda:us-east-2:615299751070:layer:AWSOpenTelemetryDistroJs:16';

/** Server build reported to apps: the commit CodeBuild synthesises, else `dev`. */
export const BUILD_VERSION = process.env.CODEBUILD_RESOLVED_SOURCE_VERSION?.slice(0, 7) ?? 'dev';

/**
 * Monthly cost budget in USD for the whole project. Both pipelines deploy it, so a change takes
 * effect on `dev` and holds once merged to `main`.
 */
export const BUDGET_USD = 10;

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

export const STAGES: StageConfig[] = [
  {
    name: 'dev',
    branch: 'dev',
    // A hyphen marks a prerelease; the two stages partition `v*`.
    releaseTags: { tagsIncludes: ['v*-*'] },
    domainName: 'reader-dev.example.com',
    retainData: false,
    backupDays: 1,
    compatTrace: true,
    archive: true,
    traceSampling: 1,
  },
  {
    name: 'prod',
    branch: 'main',
    releaseTags: { tagsIncludes: ['v*'], tagsExcludes: ['v*-*'] },
    domainName: 'reader.example.com',
    retainData: true,
    backupDays: 14,
    compatTrace: false,
    archive: true,
    traceSampling: 1,
  },
];

/**
 * Physical name for a stage's resource, `rss-reader-<stage>-<parts>`, so resources are
 * recognisable in a shared account.
 */
export const resourceName = (stage: StageConfig, ...parts: string[]) =>
  [PROJECT, stage.name, ...parts].join('-');

/** Where the app downloads live, in the downloads bucket and under the stage's domain. */
export const DOWNLOADS_PREFIX = 'downloads';

/**
 * The stage's downloads bucket, named so the release pipeline can be granted it without a
 * cross-stack reference.
 */
export const downloadsBucketName = (stage: StageConfig) =>
  `${resourceName(stage, 'downloads')}-${ACCOUNT}`;

/** SecureString parameters with the signing material, shared by both stages' release pipelines. */
export const SIGNING_PARAMETERS = '/rss-reader/release';
