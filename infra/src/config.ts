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

export interface StageConfig {
  name: 'dev' | 'prod';
  /** Branch whose pushes deploy this stage. */
  branch: string;
  domainName: string;
  /** Production keeps its data when stacks are deleted. */
  retainData: boolean;
  backupDays: number;
  /** Log every compatibility-API call (credentials redacted) to capture client behaviour. */
  compatTrace: boolean;
}

export const STAGES: StageConfig[] = [
  {
    name: 'dev',
    branch: 'dev',
    domainName: 'reader-dev.example.com',
    retainData: false,
    backupDays: 1,
    compatTrace: true,
  },
  {
    name: 'prod',
    branch: 'main',
    domainName: 'reader.example.com',
    retainData: true,
    backupDays: 14,
    compatTrace: false,
  },
];

/**
 * Physical name for a stage's resource, `rss-reader-<stage>-<parts>`, so resources are
 * recognisable in a shared account.
 */
export const resourceName = (stage: StageConfig, ...parts: string[]) =>
  [PROJECT, stage.name, ...parts].join('-');
