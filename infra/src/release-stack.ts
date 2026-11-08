import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';
import { DOWNLOADS_PREFIX, type StageConfig } from './config.ts';
import {
  downloadsBucketName,
  GITHUB_CONNECTION_ARN,
  GITHUB_REPO,
  resourceName,
  SIGNING_PARAMETERS,
} from './deploy-config.ts';
import { notifyResults, pipelinesTopicName } from './pipeline-notifications.ts';
import { IMAGE_ARCHES, imageRepositoryName } from './release/image.ts';

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
 * Windows, and the server image on x64 and ARM when the stage has an image repository, all in
 * parallel; signs the apps; and publishes them to the stage's downloads bucket and the image to
 * its repository. Branch runs (the run on creation, a manual release) skip the build and publish
 * stages. Each run's result goes to the stage's pipelines topic.
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
      buildspec = leg,
    ) =>
      new codebuild.PipelineProject(this, id, {
        projectName: resourceName(stage, 'release', leg),
        description: `Release ${leg} leg for ${stage.domainName}`,
        buildSpec: codebuild.BuildSpec.fromSourceFilename(
          `infra/buildspec/release-${buildspec}.yml`,
        ),
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
    // Each architecture builds natively; Docker needs privileged mode.
    const repository = stage.imageRepository;
    const imageLegs = (repository ? IMAGE_ARCHES : []).map((arch) => {
      const id = arch === 'amd64' ? 'ImageAmd64' : 'ImageArm64';
      return {
        id,
        project: project(
          id,
          `image-${arch}`,
          {
            buildImage:
              arch === 'amd64'
                ? codebuild.LinuxBuildImage.STANDARD_7_0
                : codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0,
            computeType: codebuild.ComputeType.MEDIUM,
            privileged: true,
            environmentVariables: {
              ARTIFACT_BUCKET: { value: scratch.bucketName },
              IMAGE_REPOSITORY: { value: repository },
              IMAGE_ARCH: { value: arch },
              NEWSES_SOURCE: { value: `https://github.com/${GITHUB_REPO}` },
            },
          },
          Duration.hours(1),
          'image',
        ),
      };
    });
    const publish = project(
      'Publish',
      'publish',
      {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0,
        computeType: codebuild.ComputeType.SMALL,
        privileged: Boolean(repository),
        environmentVariables: {
          ARTIFACT_BUCKET: { value: scratch.bucketName },
          DOWNLOADS_BUCKET: { value: downloads.bucketName },
          DOWNLOADS_URL: { value: downloadsUrl },
          // Prereleases are published only to dev, and superseded ones expire.
          PRERELEASE: { value: String(stage.name !== 'prod') },
          ...(repository && { IMAGE_REPOSITORY: { value: repository } }),
        },
      },
      Duration.minutes(30),
    );
    for (const leg of [linux, windows, ...imageLegs.map((image) => image.project)]) {
      scratch.grantReadWrite(leg, 'releases/*');
      scratch.grantRead(leg, 'try/*');
    }
    scratch.grantRead(publish);
    downloads.grantReadWrite(publish, `${DOWNLOADS_PREFIX}/*`);

    // The image legs push by digest; the publish leg tags and deletes too. Pulls need no grant.
    if (repository) {
      const repositoryArn = this.formatArn({
        service: 'ecr-public',
        region: '',
        resource: 'repository',
        resourceName: imageRepositoryName(repository),
      });
      const push = [
        'ecr-public:BatchCheckLayerAvailability',
        'ecr-public:InitiateLayerUpload',
        'ecr-public:UploadLayerPart',
        'ecr-public:CompleteLayerUpload',
        'ecr-public:PutImage',
      ];
      const grantImage = (leg: codebuild.PipelineProject, actions: string[]) => {
        leg.addToRolePolicy(new iam.PolicyStatement({ actions, resources: [repositoryArn] }));
        leg.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ['ecr-public:GetAuthorizationToken', 'sts:GetServiceBearerToken'],
            resources: ['*'],
          }),
        );
      };
      for (const { project: leg } of imageLegs) grantImage(leg, push);
      grantImage(publish, [...push, 'ecr-public:DescribeImageTags', 'ecr-public:BatchDeleteImage']);
    }

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
    const releaseCommit = { RELEASE_COMMIT: { value: '#{SourceVariables.CommitId}' } };

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
            ...imageLegs.map(
              ({ id, project: leg }) =>
                new actions.CodeBuildAction({
                  actionName: id,
                  project: leg,
                  input: source,
                  environmentVariables: { ...releaseTag, ...releaseCommit },
                }),
            ),
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

    // The pipeline stack owns the topic and lets CodeStar Notifications publish to it.
    const results = sns.Topic.fromTopicArn(
      this,
      'Results',
      this.formatArn({ service: 'sns', resource: pipelinesTopicName(stage) }),
    );
    notifyResults(pipeline, results, resourceName(stage, 'release-results'));

    // scripts/try-release.sh starts the projects directly and reads these.
    const outputs: Record<string, string> = {
      PipelineName: pipeline.pipelineName,
      ScratchBucket: scratch.bucketName,
      LinuxProject: linux.projectName,
      WindowsProject: windows.projectName,
      PublishProject: publish.projectName,
      ...Object.fromEntries(
        imageLegs.map(({ id, project: leg }) => [`${id}Project`, leg.projectName]),
      ),
    };
    for (const [key, value] of Object.entries(outputs)) new CfnOutput(this, key, { value });
  }
}
