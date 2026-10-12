import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ACCOUNT, ADOT_LAYER_ARN, CERTIFICATE_ARN, REGION, STAGES } from './config.ts';
import { API_PATHS } from './edge-stack.ts';
import { PipelineStack } from './pipeline-stack.ts';
import { RssReaderStage } from './stage.ts';

// Skips Lambda bundling, which needs esbuild and network access.
const newApp = () => new App({ context: { 'aws:cdk:bundling-stacks': [] } });
const webDir = mkdtempSync(join(tmpdir(), 'web-'));
writeFileSync(join(webDir, 'index.html'), '<!doctype html>');

const [dev, prod] = STAGES;
if (!dev || !prod) throw new Error('dev and prod stages are configured');
const stage = new RssReaderStage(newApp(), 'Test', { stage: dev, webDir });
const params = Template.fromStack(stage.params);
const data = Template.fromStack(stage.data);
const app = Template.fromStack(stage.app);
const edge = Template.fromStack(stage.edge);
const release = Template.fromStack(stage.release);

describe('RssReaderStage', () => {
  it('keeps generated credentials in SSM parameters rather than Secrets Manager', () => {
    for (const template of [params, data, app, edge]) {
      template.resourceCountIs('AWS::SecretsManager::Secret', 0);
    }
    params.resourceCountIs('Custom::GeneratedParameter', 4);
    for (const template of [data, app, edge]) {
      template.resourceCountIs('Custom::GeneratedParameter', 0);
    }
    expect(stage.data.dependencies).toContain(stage.params);
    data.hasResourceProperties('AWS::RDS::DBCluster', {
      MasterUserPassword: '{{resolve:ssm-secure:/rss-reader/dev/db-password}}',
    });
  });

  it('names and tags resources with the project and stage', () => {
    expect(
      [stage.params, stage.data, stage.app, stage.edge, stage.release].map((s) => s.stackName),
    ).toEqual([
      'rss-reader-dev-params',
      'rss-reader-dev-data',
      'rss-reader-dev-app',
      'rss-reader-dev-edge',
      'rss-reader-dev-release',
    ]);
    const functions = Object.values(
      app.findResources('AWS::Lambda::Function', {
        Properties: {
          Environment: { Variables: Match.objectLike({ DB_HOST: Match.anyValue() }) },
        },
      }),
    ) as { Properties: { FunctionName: string; Tags: { Key: string; Value: string }[] } }[];
    expect(functions.map((f) => f.Properties.FunctionName).sort()).toEqual(
      ['api', 'extract', 'favicon', 'fetch', 'migrate', 'tick'].map(
        (name) => `rss-reader-dev-${name}`,
      ),
    );
    for (const { Properties } of functions) {
      expect(Properties.Tags).toEqual(
        expect.arrayContaining([
          { Key: 'project', Value: 'rss-reader' },
          { Key: 'stage', Value: 'dev' },
        ]),
      );
    }
    data.hasResourceProperties('AWS::RDS::DBCluster', { DBClusterIdentifier: 'rss-reader-dev' });
    data.hasResourceProperties('AWS::RDS::DBInstance', {
      DBInstanceIdentifier: 'rss-reader-dev-writer',
    });
    app.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'rss-reader-dev-feed-fetch' });
    app.hasResourceProperties('AWS::Scheduler::Schedule', { Name: 'rss-reader-dev-auth-prune' });
    edge.hasResourceProperties('AWS::CloudFront::Function', { Name: 'rss-reader-dev-spa-routes' });
    edge.hasResourceProperties('AWS::CloudFront::Function', {
      Name: 'rss-reader-dev-utf8-charset',
    });
  });

  it('gives every Lambda function a log group the stack owns', () => {
    for (const template of [data, app, edge]) {
      for (const fn of Object.values(template.findResources('AWS::Lambda::Function'))) {
        expect(fn).toMatchObject({
          Properties: { LoggingConfig: { LogGroup: expect.anything() as unknown } },
        });
      }
    }
  });

  it('keeps every stack in one region, so pipelines need no cross-region support stacks', () => {
    const regions = stage.node
      .findAll()
      .filter((c): c is Stack => Stack.isStack(c))
      .map((s) => s.region);
    expect(new Set(regions)).toEqual(new Set([REGION]));
  });
});

describe('Data', () => {
  it('runs Aurora Serverless v2 that pauses at 0 ACU and requires TLS, without NAT', () => {
    data.resourceCountIs('AWS::EC2::NatGateway', 0);
    data.hasResourceProperties('AWS::RDS::DBCluster', {
      Engine: 'aurora-postgresql',
      ServerlessV2ScalingConfiguration: Match.objectLike({
        MinCapacity: 0,
        SecondsUntilAutoPause: 300,
      }),
      StorageEncrypted: true,
    });
    data.hasResourceProperties('AWS::RDS::DBClusterParameterGroup', {
      Parameters: { 'rds.force_ssl': '1' },
    });
  });
});

describe('App', () => {
  it('runs every function on ARM64 Node 24 outside any VPC', () => {
    const functions = Object.values(
      app.findResources('AWS::Lambda::Function', {
        Properties: {
          Environment: { Variables: Match.objectLike({ DB_PASSWORD_PARAMETER: Match.anyValue() }) },
        },
      }),
    ) as { Properties: Record<string, unknown> }[];
    expect(functions).toHaveLength(6);
    app.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'rss-reader-dev-api',
      Environment: { Variables: Match.objectLike({ TRUST_PROXY: '2' }) },
    });
    for (const { Properties } of functions) {
      expect(Properties.Runtime).toBe('nodejs24.x');
      expect(Properties.Architectures).toEqual(['arm64']);
      expect(Properties.VpcConfig).toBeUndefined();
    }
  });

  it('fetches at most 8 hosts at once and schedules dispatch, purge, prune, and compaction', () => {
    app.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 1,
      ScalingConfig: { MaximumConcurrency: 8 },
    });
    app.resourceCountIs('AWS::Scheduler::Schedule', 4);
    app.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'cron(0/30 * * * ? *)',
    });
  });

  it('traces every function through the ADOT layer at the stage rate, without active tracing', () => {
    const functions = Object.values(
      app.findResources('AWS::Lambda::Function', {
        Properties: {
          Environment: { Variables: Match.objectLike({ DB_PASSWORD_PARAMETER: Match.anyValue() }) },
        },
      }),
    ) as {
      Properties: {
        Layers?: string[];
        TracingConfig?: unknown;
        Environment: { Variables: Record<string, string> };
      };
    }[];
    for (const { Properties } of functions) {
      expect(Properties.Layers).toEqual([ADOT_LAYER_ARN]);
      expect(Properties.TracingConfig).toBeUndefined();
      expect(Properties.Environment.Variables).toMatchObject({
        AWS_LAMBDA_EXEC_WRAPPER: '/opt/otel-instrument',
        OTEL_TRACES_SAMPLER: 'traceidratio',
        OTEL_TRACES_SAMPLER_ARG: String(dev.traceSampling),
        OTEL_AWS_APPLICATION_SIGNALS_ENABLED: 'false',
        OTEL_NODE_DISABLED_INSTRUMENTATIONS: 'http',
      });
    }
    app.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'] }),
        ]),
      },
    });

    const untraced = Template.fromStack(
      new RssReaderStage(newApp(), 'Test', { stage: { ...dev, traceSampling: 0 }, webDir }).app,
    );
    for (const fn of Object.values(untraced.findResources('AWS::Lambda::Function'))) {
      expect(JSON.stringify(fn)).not.toContain('otel-instrument');
    }
  });

  it('publishes operations alerts from tick to the stage topic', () => {
    app.hasResourceProperties('AWS::SNS::Topic', { TopicName: 'rss-reader-dev-alerts' });
    app.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'rss-reader-dev-tick',
      Environment: { Variables: Match.objectLike({ ALERT_TOPIC_ARN: Match.anyValue() }) },
    });
    app.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'rss-reader-dev-api',
      Environment: {
        Variables: Match.not(Match.objectLike({ ALERT_TOPIC_ARN: Match.anyValue() })),
      },
    });
  });

  it('keeps one project budget, owned by the stage that sets its limit', () => {
    expect(dev.budgetUsd).toBeUndefined();
    app.resourceCountIs('AWS::Budgets::Budget', 0);
    const owner = Template.fromStack(
      new RssReaderStage(newApp(), 'Test', { stage: prod, webDir }).app,
    );
    owner.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({
        BudgetName: 'rss-reader',
        BudgetLimit: { Amount: prod.budgetUsd, Unit: 'USD' },
        FilterExpression: {
          Tags: { Key: 'project', Values: ['rss-reader'], MatchOptions: ['EQUALS'] },
        },
      }),
      NotificationsWithSubscribers: [
        Match.objectLike({
          Notification: Match.objectLike({ NotificationType: 'ACTUAL', Threshold: 80 }),
        }),
        Match.objectLike({
          Notification: Match.objectLike({ NotificationType: 'ACTUAL', Threshold: 100 }),
        }),
        Match.objectLike({
          Notification: Match.objectLike({ NotificationType: 'FORECASTED', Threshold: 100 }),
        }),
      ],
    });
    owner.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: {
        Statement: [Match.objectLike({ Principal: { Service: 'budgets.amazonaws.com' } })],
      },
    });
  });

  it('archives in the blob bucket, catalogued for Athena by month, on both stages', () => {
    data.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Prefix: 'archive/entries/',
            Transitions: [{ StorageClass: 'INTELLIGENT_TIERING', TransitionInDays: 0 }],
          }),
        ]),
      },
    });
    data.hasOutput('BlobBucket', {});
    data.hasResourceProperties('AWS::Glue::Database', {
      DatabaseInput: { Name: 'rss_reader_dev' },
    });
    data.hasResourceProperties('AWS::Glue::Table', {
      TableInput: Match.objectLike({
        Name: 'archive_entries',
        PartitionKeys: [{ Name: 'month', Type: 'string' }],
        Parameters: Match.objectLike({
          'projection.month.type': 'date',
          'projection.month.format': 'yyyy-MM',
        }),
        StorageDescriptor: Match.objectLike({
          Columns: Match.arrayWith([
            { Name: 'id', Type: 'bigint' },
            { Name: 'sort_at', Type: 'timestamp' },
            {
              Name: 'enclosures',
              Type: 'array<struct<url:string,mime_type:string,length:bigint,width:int,height:int,duration_seconds:int>>',
            },
          ]),
        }),
      }),
    });
    app.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'rss-reader-dev-tick',
      Environment: { Variables: Match.objectLike({ ARCHIVE_ENABLED: 'true' }) },
    });
    expect(prod.archive).toBe(true);
  });

  it('reads and compacts the archive through an Athena workgroup', () => {
    data.hasResourceProperties('AWS::Athena::WorkGroup', {
      Name: 'rss-reader-dev',
      WorkGroupConfiguration: Match.objectLike({ EnforceWorkGroupConfiguration: true }),
    });
    app.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'rss-reader-dev-api',
      Environment: {
        Variables: Match.objectLike({
          ARCHIVE_ATHENA_WORKGROUP: 'rss-reader-dev',
          ARCHIVE_ATHENA_DATABASE: 'rss_reader_dev',
        }),
      },
    });
    app.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: Match.arrayWith(['athena:StartQueryExecution']) }),
        ]),
      },
    });
    app.hasResourceProperties('AWS::Scheduler::Schedule', {
      Name: 'rss-reader-dev-archive-compact',
      ScheduleExpression: 'cron(0 4 * * ? *)',
    });
  });
});

describe('Edge', () => {
  it('serves the SPA from a private bucket and the API paths from the HTTP API', () => {
    edge.resourceCountIs('AWS::CloudFront::OriginAccessControl', 2);
    edge.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: [dev.domainName],
        ViewerCertificate: Match.objectLike({ AcmCertificateArn: CERTIFICATE_ARN }),
        CacheBehaviors: [
          Match.objectLike({ PathPattern: '/downloads' }),
          Match.objectLike({ PathPattern: '/downloads/*', AllowedMethods: ['GET', 'HEAD'] }),
          // Managed CachingOptimized policy.
          Match.objectLike({
            PathPattern: '/api/v1/images/*',
            CachePolicyId: '658327ea-f89d-4fab-a63d-7e88639e58f6',
          }),
          ...API_PATHS.map((path) => Match.objectLike({ PathPattern: path })),
        ],
      }),
    });
    edge.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: `${dev.domainName}.`,
      Type: 'A',
    });
  });
});

describe('Downloads', () => {
  it('keeps downloads in their own named bucket, where superseded prereleases expire', () => {
    edge.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: `rss-reader-dev-downloads-${ACCOUNT}`,
      LifecycleConfiguration: {
        Rules: [
          Match.objectLike({
            TagFilters: [{ Key: 'superseded', Value: 'true' }],
            ExpirationInDays: 30,
          }),
        ],
      },
    });
    edge.hasResourceProperties('AWS::CloudFront::Function', {
      Name: 'rss-reader-dev-downloads-index',
    });
  });
});

describe('Release', () => {
  it('releases from prerelease tags to dev, and other version tags to prod', () => {
    for (const config of STAGES) {
      const template = Template.fromStack(
        new RssReaderStage(newApp(), 'Test', { stage: config, webDir }).release,
      );
      template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
        Name: `rss-reader-${config.name}-release`,
        Triggers: [
          Match.objectLike({
            GitConfiguration: Match.objectLike({
              Push: [
                {
                  Tags:
                    config.name === 'prod'
                      ? { Includes: ['v*'], Excludes: ['v*-*'] }
                      : { Includes: ['v*-*'] },
                },
              ],
            }),
          }),
        ],
      });
    }
  });

  it('builds and publishes only for a tag', () => {
    release.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Stages: [
        Match.objectLike({ Name: 'Source' }),
        Match.objectLike({
          Name: 'Build',
          BeforeEntry: Match.anyValue(),
          Actions: [
            Match.objectLike({ Name: 'LinuxAndroid' }),
            Match.objectLike({ Name: 'Windows' }),
          ],
        }),
        Match.objectLike({ Name: 'Publish', BeforeEntry: Match.anyValue() }),
      ],
    });
  });

  it("gives each leg only its own signing parameters, and only publish the stage's downloads", () => {
    const policies = Object.entries(release.findResources('AWS::IAM::Policy')).map(
      ([id, policy]) => [id, JSON.stringify(policy)] as const,
    );
    const policy = (role: string) => {
      const found = policies.find(([id]) => id.startsWith(role));
      if (!found) throw new Error(`No policy for ${role}`);
      return found[1];
    };
    expect(policy('LinuxRole')).toContain('/rss-reader/release/android-signing/keystore');
    expect(policy('LinuxRole')).not.toContain('windows-signing');
    expect(policy('WindowsRole')).toContain('/rss-reader/release/windows-signing/client-secret');
    expect(policy('WindowsRole')).not.toContain('android-signing');
    expect(policy('PublishRole')).not.toContain('-signing');
    for (const [id, document] of policies) {
      expect(document.includes(`rss-reader-dev-downloads-${ACCOUNT}`)).toBe(
        id.startsWith('PublishRole'),
      );
      expect(document).not.toContain('rss-reader-prod');
    }
  });
});

describe('PipelineStack', () => {
  it.each(STAGES)('deploys $name from the $branch branch', (config) => {
    const root = newApp();
    const pipeline = new PipelineStack(root, `rss-reader-${config.name}-pipeline`, {
      env: { account: ACCOUNT, region: REGION },
      stage: config,
      webDir,
    });
    const template = Template.fromStack(pipeline);
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Stages: Match.arrayWith([
        Match.objectLike({
          Name: 'Source',
          Actions: [
            Match.objectLike({ Configuration: Match.objectLike({ BranchName: config.branch }) }),
          ],
        }),
      ]),
    });
    // Inline buildspecs are JSON; the asset publishing project names a buildspec file instead.
    const buildSpecs = Object.values(template.findResources('AWS::CodeBuild::Project'))
      .map(
        (project) =>
          (project as { Properties: { Source: { BuildSpec: string } } }).Properties.Source
            .BuildSpec,
      )
      .filter((spec) => spec.startsWith('{'))
      .map(
        (spec) =>
          JSON.parse(spec) as {
            phases: {
              install?: { 'runtime-versions'?: Record<string, unknown>; commands?: string[] };
            };
          },
      );
    const synth = buildSpecs.find((spec) =>
      spec.phases.install?.commands?.includes('corepack enable'),
    );
    expect(synth?.phases.install?.['runtime-versions']).toEqual({ nodejs: 24 });
    // All build projects log to the pipeline's own expiring group.
    for (const project of Object.values(template.findResources('AWS::CodeBuild::Project'))) {
      expect(project).toMatchObject({
        Properties: {
          LogsConfig: { CloudWatchLogs: { GroupName: expect.anything() as unknown } },
        },
      });
    }
    template.resourcePropertiesCountIs(
      'AWS::CodeBuild::Project',
      { Description: Match.stringLikeRegexp('FileAsset') },
      1,
    );
    const stackNames = root.node
      .findAll()
      .filter((c): c is Stack => Stack.isStack(c))
      .map((s) => s.stackName);
    expect(stackNames.sort()).toEqual(
      ['app', 'data', 'edge', 'params', 'pipeline', 'release'].map(
        (part) => `rss-reader-${config.name}-${part}`,
      ),
    );
  });
});
