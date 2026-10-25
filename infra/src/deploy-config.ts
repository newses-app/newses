import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isReservedAdminLogin, loginNameSchema } from '@newses/shared';
import { z } from 'zod';
import { REPO_ROOT, type StageConfig } from './config.ts';

const stageSchema = z.object({
  name: z.enum(['dev', 'prod']),
  branch: z.string().min(1),
  // A hyphen marks a prerelease; the two stages partition `v*`.
  releaseTags: z.object({
    tagsIncludes: z.array(z.string()).min(1),
    tagsExcludes: z.array(z.string()).optional(),
  }),
  domainName: z.string().min(1),
  retainData: z.boolean(),
  backupDays: z.int().min(1),
  compatTrace: z.boolean(),
  archive: z.boolean(),
  traceSampling: z.number().min(0).max(1),
  instanceName: z.string().trim().min(1).max(100).optional(),
  downloadsCorsOrigins: z.array(z.string().regex(/^https:\/\/[^/]+$/)).optional(),
}) satisfies z.ZodType<StageConfig>;

export const deployConfigSchema = z
  .object({
    /** Prefix of every physical name, tag, and parameter path in the account. */
    resourcePrefix: z.string().regex(/^[a-z][a-z0-9-]*$/),
    account: z.string().regex(/^\d{12}$/),
    region: z.string().min(1),
    /** `owner/name` of the GitHub repository the pipelines build. */
    githubRepo: z.string().regex(/^[^/]+\/[^/]+$/),
    /** CodeConnections connection with access to that repository. */
    githubConnectionArn: z.string().startsWith('arn:aws:'),
    /** Covers every stage's domain; CloudFront requires certificates from us-east-1. */
    certificateArn: z.string().startsWith('arn:aws:acm:us-east-1:'),
    /** The Route 53 zone every stage's domain is directly under. */
    hostedZone: z.object({ zoneName: z.string().min(1), hostedZoneId: z.string().min(1) }),
    /**
     * AWS Distro for OpenTelemetry (JavaScript) Lambda layer; ARNs are regional and versioned,
     * listed at https://aws-otel.github.io/docs/getting-started/lambda.
     */
    adotLayerArn: z.string().startsWith('arn:aws:lambda:'),
    /**
     * Monthly cost budget in USD for running the project, both stages, without the build
     * pipelines. Both pipelines deploy it, so a change takes effect on `dev` and holds once
     * merged to `main`.
     */
    budgetUsd: z.number().positive(),
    /** Login of each stage's first admin, created with a generated password. */
    adminLogin: loginNameSchema.refine((login) => !isReservedAdminLogin(login), {
      message: 'too well known for the first admin; choose another login',
    }),
    stages: z.array(stageSchema).min(1),
  })
  .superRefine((config, ctx) => {
    for (const stage of config.stages) {
      if (!stage.domainName.endsWith(`.${config.hostedZone.zoneName}`)) {
        ctx.addIssue({
          code: 'custom',
          message: `${stage.domainName} is not under ${config.hostedZone.zoneName}`,
        });
      }
    }
    if (new Set(config.stages.map((stage) => stage.name)).size !== config.stages.length) {
      ctx.addIssue({ code: 'custom', message: 'stage names repeat' });
    }
  });

// The deployment's account-specific values, from `infra/deploy.config.json` (not committed; see
// `deploy.config.example.json`) or the file `NEWSES_DEPLOY_CONFIG` names. The pipelines' synth
// step writes the file from the `DEPLOY_CONFIG_PARAMETER` parameter.
const path = process.env.NEWSES_DEPLOY_CONFIG ?? join(REPO_ROOT, 'infra', 'deploy.config.json');
if (!existsSync(path)) {
  throw new Error(
    `No deployment config at ${path}: copy infra/deploy.config.example.json and fill it in, or ` +
      'fetch it with aws ssm get-parameter --name /<resourcePrefix>/deploy-config',
  );
}
const config = deployConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));

export const PROJECT = config.resourcePrefix;
export const ACCOUNT = config.account;
export const REGION = config.region;
export const GITHUB_REPO = config.githubRepo;
export const GITHUB_CONNECTION_ARN = config.githubConnectionArn;
export const CERTIFICATE_ARN = config.certificateArn;
export const HOSTED_ZONE = config.hostedZone;
export const ADOT_LAYER_ARN = config.adotLayerArn;
export const BUDGET_USD = config.budgetUsd;
export const ADMIN_LOGIN = config.adminLogin;
export const STAGES: StageConfig[] = config.stages;

/**
 * Physical name for a stage's resource, `<prefix>-<stage>-<parts>`, so resources are
 * recognisable in a shared account.
 */
export const resourceName = (stage: StageConfig, ...parts: string[]) =>
  [PROJECT, stage.name, ...parts].join('-');

/** The stage's database on the shared instance, and the role that owns it. */
export const dbName = (stage: StageConfig) => `${PROJECT}_${stage.name}`.replaceAll('-', '_');

/** The shared database instance's master user, which creates each stage's role and database. */
export const DB_MASTER_USER = 'rss_admin';
export const DB_MASTER_PASSWORD_PARAMETER = `/${PROJECT}/db/master-password`;
/** String parameter with the shared instance's address, which stages read at deployment. */
export const DB_ENDPOINT_PARAMETER = `/${PROJECT}/db/endpoint`;

/** SecureString parameters with the signing material, shared by both stages' release pipelines. */
export const SIGNING_PARAMETERS = `/${PROJECT}/release`;

/** String parameter with this config, which the pipelines' synth step fetches. */
export const DEPLOY_CONFIG_PARAMETER = `/${PROJECT}/deploy-config`;

/**
 * The stage's downloads bucket, named so the release pipeline can be granted it without a
 * cross-stack reference.
 */
export const downloadsBucketName = (stage: StageConfig) =>
  `${resourceName(stage, 'downloads')}-${ACCOUNT}`;
