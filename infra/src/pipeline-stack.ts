import { Stack, type StackProps } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import { PipelineType } from 'aws-cdk-lib/aws-codepipeline';
import * as pipelines from 'aws-cdk-lib/pipelines';
import type { Construct } from 'constructs';
import { GITHUB_CONNECTION_ARN, GITHUB_REPO, type StageConfig } from './config.ts';
import { RssReaderStage } from './stage.ts';

const ARM_BUILD_IMAGE = codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0;

/**
 * Self-mutating pipeline: each push to the stage's branch runs `pnpm check`, builds the SPA,
 * bundles the Lambdas, deploys the stage, and smoke-tests it.
 */
export class PipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps & { stage: StageConfig }) {
    super(scope, id, props);
    const { stage } = props;

    const pipeline = new pipelines.CodePipeline(this, 'Pipeline', {
      pipelineName: `rss-reader-${stage.name}`,
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
        installCommands: ['n 24', 'corepack enable', 'pnpm install --frozen-lockfile'],
        commands: [
          'pnpm check',
          'pnpm --filter @rss-reader/web build',
          'cd infra && pnpm exec cdk synth',
        ],
        primaryOutputDirectory: 'infra/cdk.out',
      }),
      codeBuildDefaults: { buildEnvironment: { buildImage: ARM_BUILD_IMAGE } },
    });

    pipeline.addStage(new RssReaderStage(this, stage.name === 'dev' ? 'Dev' : 'Prod', { stage }), {
      post: [
        new pipelines.ShellStep('SmokeTest', {
          commands: [
            `curl -fsS -o /dev/null https://${stage.domainName}/`,
            `test "$(curl -s -o /dev/null -w '%{http_code}' https://${stage.domainName}/api/v1/subscriptions)" = 401`,
          ],
        }),
      ],
    });
  }
}
