import { RemovalPolicy, Stack, type StackProps, Tags } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import { PipelineType } from 'aws-cdk-lib/aws-codepipeline';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as pipelines from 'aws-cdk-lib/pipelines';
import type { Construct } from 'constructs';
import { BudgetStage } from './budget.ts';
import {
  BUDGET_USD,
  GITHUB_CONNECTION_ARN,
  GITHUB_REPO,
  PROJECT,
  resourceName,
  type StageConfig,
} from './config.ts';
import { RssReaderStage } from './stage.ts';

const ARM_BUILD_IMAGE = codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0;

/**
 * Self-mutating pipeline: each push to the stage's branch runs `pnpm check`, builds the SPA,
 * bundles the Lambdas, deploys the stage, smoke-tests it, and deploys the shared project budget.
 */
export class PipelineStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    props: StackProps & {
      stage: StageConfig;
      /** Built web app; tests pass a fixture. */ webDir?: string;
    },
  ) {
    super(scope, id, props);
    const { stage } = props;

    Tags.of(this).add('project', PROJECT);
    Tags.of(this).add('stage', stage.name);

    // Every build project logs here; otherwise CodeBuild creates a never-expiring group per
    // project, and asset projects are recreated with new names.
    const buildLogs = new logs.LogGroup(this, 'BuildLogs', {
      logGroupName: `/aws/codebuild/${resourceName(stage, 'pipeline')}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const pipeline = new pipelines.CodePipeline(this, 'Pipeline', {
      pipelineName: resourceName(stage),
      // One project publishes every file asset, instead of one project per asset.
      publishAssetsInParallel: false,
      pipelineType: PipelineType.V2,
      crossAccountKeys: false,
      synth: new pipelines.CodeBuildStep('Synth', {
        input: pipelines.CodePipelineSource.connection(GITHUB_REPO, stage.branch, {
          connectionArn: GITHUB_CONNECTION_ARN,
        }),
        buildEnvironment: {
          buildImage: ARM_BUILD_IMAGE,
          computeType: codebuild.ComputeType.LARGE,
          // Tests start Postgres and S3 containers.
          privileged: true,
          environmentVariables: {
            // The build host is discarded afterwards, so the reaper container is not needed.
            TESTCONTAINERS_RYUK_DISABLED: { value: 'true' },
          },
        },
        // Node 24 is preinstalled on the image, so this only selects it.
        partialBuildSpec: codebuild.BuildSpec.fromObject({
          phases: { install: { 'runtime-versions': { nodejs: 24 } } },
        }),
        installCommands: ['node --version', 'corepack enable', 'pnpm install --frozen-lockfile'],
        commands: [
          'pnpm check',
          'pnpm audit --prod --audit-level high',
          'pnpm --filter @rss-reader/web build',
          'cd infra && pnpm exec cdk synth',
        ],
        primaryOutputDirectory: 'infra/cdk.out',
      }),
      codeBuildDefaults: {
        buildEnvironment: { buildImage: ARM_BUILD_IMAGE },
        logging: { cloudWatch: { logGroup: buildLogs } },
      },
    });

    pipeline.addStage(
      new RssReaderStage(this, resourceName(stage), {
        stage,
        webDir: props.webDir,
      }),
      {
        post: [
          new pipelines.ShellStep('SmokeTest', {
            commands: [
              `curl -fsS -o /dev/null https://${stage.domainName}/`,
              `test "$(curl -s -o /dev/null -w '%{http_code}' https://${stage.domainName}/api/v1/subscriptions)" = 401`,
              // The apps' CORS preflight reaches the API through CloudFront.
              `curl -fsS -o /dev/null -D - -X OPTIONS -H 'Origin: app://rss-reader' -H 'Access-Control-Request-Method: GET' -H 'Access-Control-Request-Headers: authorization' https://${stage.domainName}/api/v1/subscriptions | grep -qi '^access-control-allow-origin: app://rss-reader'`,
            ],
          }),
        ],
      },
    );
    // Shared by both pipelines; deploying it after the stage keeps a clash between them (the
    // stack busy with the other pipeline's update) from holding up the stage. A retry clears it.
    pipeline.addStage(new BudgetStage(this, `${PROJECT}-budget`, { limitUsd: BUDGET_USD }));
  }
}
