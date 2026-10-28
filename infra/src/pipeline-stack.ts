import { RemovalPolicy, Stack, type StackProps, Tags } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import { PipelineType } from 'aws-cdk-lib/aws-codepipeline';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as pipelines from 'aws-cdk-lib/pipelines';
import type { Construct } from 'constructs';
import { BudgetStage } from './budget.ts';
import { type StageConfig } from './config.ts';
import {
  BUDGET_USD,
  DEPLOY_CONFIG_PARAMETER,
  GITHUB_CONNECTION_ARN,
  GITHUB_REPO,
  PROJECT,
  resourceName,
} from './deploy-config.ts';
import { DatabaseStage } from './database.ts';
import { notifyResults, pipelinesTopicName } from './pipeline-notifications.ts';
import { NewsesStage } from './stage.ts';

const ARM_BUILD_IMAGE = codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0;

/**
 * Self-mutating pipeline: each push to the stage's branch runs `pnpm check`, builds the SPA,
 * bundles the Lambdas, deploys the shared database, then the stage and the shared project budget
 * side by side, and smoke-tests the stage. Each run's result goes to the stage's pipelines topic.
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
      // One deploy action per stack: preparing a change set first costs about 40 s a stack, even
      // when nothing changed, and nothing reviews the change sets.
      useChangeSets: false,
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
          // The deployment config is kept out of the repository.
          `aws ssm get-parameter --name ${DEPLOY_CONFIG_PARAMETER} --query Parameter.Value --output text > infra/deploy.config.json`,
          'pnpm check',
          'pnpm audit --prod --audit-level high',
          'pnpm --filter @newses/web build',
          'cd infra && pnpm exec cdk synth',
        ],
        primaryOutputDirectory: 'infra/cdk.out',
        rolePolicyStatements: [
          new iam.PolicyStatement({
            actions: ['ssm:GetParameter'],
            resources: [
              Stack.of(this).formatArn({
                service: 'ssm',
                resource: 'parameter',
                resourceName: DEPLOY_CONFIG_PARAMETER.slice(1),
              }),
            ],
          }),
        ],
      }),
      codeBuildDefaults: {
        buildEnvironment: { buildImage: ARM_BUILD_IMAGE },
        logging: { cloudWatch: { logGroup: buildLogs } },
      },
    });

    // Shared by both pipelines, and needed by the stage; a clash between the pipelines (the stack
    // busy with the other pipeline's update) fails this run, and a retry clears it.
    pipeline.addStage(new DatabaseStage(this, `${PROJECT}-db`));
    // Shared by both pipelines, and deployed alongside the stage, which does not need it. It only
    // changes with its config, so a clash with the other pipeline's run is unlikely; a retry clears it.
    const wave = pipeline.addWave(resourceName(stage));
    wave.addStage(new BudgetStage(this, `${PROJECT}-budget`, { limitUsd: BUDGET_USD }));
    wave.addStage(
      new NewsesStage(this, resourceName(stage), {
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
              `curl -fsS -o /dev/null -D - -X OPTIONS -H 'Origin: app://newses' -H 'Access-Control-Request-Method: GET' -H 'Access-Control-Request-Headers: authorization' https://${stage.domainName}/api/v1/subscriptions | grep -qi '^access-control-allow-origin: app://newses'`,
            ],
          }),
        ],
      },
    );

    // The release pipeline, in the stage, reports here too.
    const results = new sns.Topic(this, 'Results', { topicName: pipelinesTopicName(stage) });
    pipeline.buildPipeline();
    notifyResults(pipeline.pipeline, results, resourceName(stage, 'deploy-results'));
  }
}
