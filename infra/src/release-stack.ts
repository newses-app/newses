import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import {
  DOWNLOADS_PREFIX,
  downloadsBucketName,
  GITHUB_CONNECTION_ARN,
  GITHUB_REPO,
  resourceName,
  SIGNING_PARAMETERS,
  type StageConfig,
} from './config.ts';

/** Build-environment variables read from SSM SecureString parameters; CodeBuild grants the reads. */
const signingParameters = (group: string, names: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(names).map(([variable, name]) => [
      variable,
      {
        type: codebuild.BuildEnvironmentVariableType.PARAMETER_STORE,
        value: `${SIGNING_PARAMETERS}/${group}/${name}`,
      },
    ]),
  );

export interface ReleaseStackProps extends StackProps {
  stage: StageConfig;
}

/**
 * The stage's release pipeline: a version tag builds the desktop and Android apps on Linux and
 * Windows in parallel, signs them, and publishes them to the stage's downloads bucket. Branch
 * runs (the run on creation, a manual release) skip the build and publish stages.
 */
export class ReleaseStack extends Stack {
  constructor(scope: Construct, id: string, props: ReleaseStackProps) {
    super(scope, id, props);
    const { stage } = props;
    const downloadsUrl = `https://${stage.domainName}/${DOWNLOADS_PREFIX}`;

    // The build legs hand their files to the publish leg here, under releases/<tag>/; a
    // try-release run uploads its source under try/<tag>/.
    const scratch = new s3.Bucket(this, 'Scratch', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(7) }],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const pipelineArtifacts = new s3.Bucket(this, 'PipelineArtifacts', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(30) }],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const downloads = s3.Bucket.fromBucketName(this, 'Downloads', downloadsBucketName(stage));

    const buildLogs = new logs.LogGroup(this, 'BuildLogs', {
      logGroupName: `/aws/codebuild/${resourceName(stage, 'release')}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // One project per leg, so each role holds only that leg's grants.
    const project = (
      id: string,
      leg: string,
      environment: codebuild.BuildEnvironment,
      timeout: Duration,
    ) =>
      new codebuild.PipelineProject(this, id, {
        projectName: resourceName(stage, 'release', leg),
        description: `Release ${leg} leg for ${stage.domainName}`,
        buildSpec: codebuild.BuildSpec.fromSourceFilename(`infra/buildspec/release-${leg}.yml`),
        environment,
        timeout,
        logging: { cloudWatch: { logGroup: buildLogs } },
      });

    // x64: the Android build tools do not run on ARM.
    const linux = project(
      'Linux',
      'linux',
      {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.LARGE,
        environmentVariables: {
          ARTIFACT_BUCKET: { value: scratch.bucketName },
          DOWNLOADS_URL: { value: downloadsUrl },
          ...signingParameters('android-signing', {
            ANDROID_KEYSTORE_BASE64: 'keystore',
            ANDROID_KEYSTORE_PASSWORD: 'keystore-password',
            ANDROID_KEY_ALIAS: 'key-alias',
            ANDROID_KEY_PASSWORD: 'key-password',
          }),
        },
      },
      Duration.hours(1),
    );
    const windows = project(
      'Windows',
      'windows',
      {
        buildImage: codebuild.WindowsBuildImage.WIN_SERVER_CORE_2022_BASE_3_0,
        computeType: codebuild.ComputeType.MEDIUM,
        environmentVariables: {
          ARTIFACT_BUCKET: { value: scratch.bucketName },
          DOWNLOADS_URL: { value: downloadsUrl },
          ...signingParameters('windows-signing', {
            AZURE_TENANT_ID: 'tenant-id',
            AZURE_CLIENT_ID: 'client-id',
            AZURE_CLIENT_SECRET: 'client-secret',
            WIN_SIGNING_ENDPOINT: 'endpoint',
            WIN_SIGNING_ACCOUNT_NAME: 'account-name',
            WIN_SIGNING_PROFILE_NAME: 'profile-name',
            WIN_PUBLISHER_NAME: 'publisher-name',
          }),
        },
      },
      Duration.hours(1),
    );
    const publish = project(
      'Publish',
      'publish',
      {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0,
        computeType: codebuild.ComputeType.SMALL,
        environmentVariables: {
          ARTIFACT_BUCKET: { value: scratch.bucketName },
          DOWNLOADS_BUCKET: { value: downloads.bucketName },
          DOWNLOADS_URL: { value: downloadsUrl },
          // Prereleases are published only to dev, and superseded ones expire.
          PRERELEASE: { value: String(stage.name !== 'prod') },
        },
      },
      Duration.minutes(30),
    );
    scratch.grantReadWrite(linux, 'releases/*');
    scratch.grantRead(linux, 'try/*');
    scratch.grantReadWrite(windows, 'releases/*');
    scratch.grantRead(windows, 'try/*');
    scratch.grantRead(publish);
    downloads.grantReadWrite(publish, `${DOWNLOADS_PREFIX}/*`);

    const source = new codepipeline.Artifact('Source');
    // CDK grants only the legacy codestar-connections prefix; this connection is codeconnections.
    const sourceRole = new iam.Role(this, 'SourceRole', {
      assumedBy: new iam.AccountRootPrincipal(),
    });
    sourceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['codeconnections:UseConnection'],
        resources: [GITHUB_CONNECTION_ARN],
      }),
    );
    const [owner = '', repo = ''] = GITHUB_REPO.split('/');
    const sourceAction = new actions.CodeStarConnectionsSourceAction({
      actionName: 'GitHub',
      connectionArn: GITHUB_CONNECTION_ARN,
      owner,
      repo,
      // Used only by runs without a tag, which skip the release stages.
      branch: stage.branch,
      output: source,
      role: sourceRole,
      variablesNamespace: 'SourceVariables',
    });

    // TagName exists only on tag-triggered runs.
    const onlyForTags: codepipeline.Conditions = {
      conditions: [
        {
          result: codepipeline.Result.SKIP,
          rules: [
            new codepipeline.Rule({
              name: 'IsReleaseTag',
              provider: 'VariableCheck',
              version: '1',
              configuration: {
                Variable: '#{SourceVariables.TagName}',
                Operator: 'MATCHES',
                Value: '^v.+',
              },
            }),
          ],
        },
      ],
    };
    const releaseTag = { RELEASE_TAG: { value: '#{SourceVariables.TagName}' } };

    const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: resourceName(stage, 'release'),
      pipelineType: codepipeline.PipelineType.V2,
      executionMode: codepipeline.ExecutionMode.QUEUED,
      crossAccountKeys: false,
      artifactBucket: pipelineArtifacts,
      triggers: [
        {
          providerType: codepipeline.ProviderType.CODE_STAR_SOURCE_CONNECTION,
          gitConfiguration: { sourceAction, pushFilter: [stage.releaseTags] },
        },
      ],
      stages: [
        { stageName: 'Source', actions: [sourceAction] },
        {
          stageName: 'Build',
          beforeEntry: onlyForTags,
          actions: [
            new actions.CodeBuildAction({
              actionName: 'LinuxAndroid',
              project: linux,
              input: source,
              environmentVariables: releaseTag,
            }),
            new actions.CodeBuildAction({
              actionName: 'Windows',
              project: windows,
              input: source,
              environmentVariables: releaseTag,
            }),
          ],
        },
        {
          stageName: 'Publish',
          beforeEntry: onlyForTags,
          actions: [
            new actions.CodeBuildAction({
              actionName: 'Publish',
              project: publish,
              input: source,
              environmentVariables: releaseTag,
            }),
          ],
        },
      ],
    });

    // scripts/try-release.sh starts the projects directly and reads these.
    const outputs: Record<string, string> = {
      PipelineName: pipeline.pipelineName,
      ScratchBucket: scratch.bucketName,
      LinuxProject: linux.projectName,
      WindowsProject: windows.projectName,
      PublishProject: publish.projectName,
    };
    for (const [key, value] of Object.entries(outputs)) new CfnOutput(this, key, { value });
  }
}
