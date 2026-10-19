import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { BUILD_SERVICES } from './budget.ts';
import {
  ACCOUNT,
  ADOT_LAYER_ARN,
  BUDGET_USD,
  CERTIFICATE_ARN,
  REGION,
  STAGES,
} from './deploy-config.ts';
import { DatabaseStage } from './database.ts';
import { API_PATHS } from './edge-stack.ts';
import { PipelineStack } from './pipeline-stack.ts';
import { NewsesStage } from './stage.ts';

// Skips Lambda bundling, which needs esbuild and network access.
const newApp = () => new App({ context: { 'aws:cdk:bundling-stacks': [] } });
const webDir = mkdtempSync(join(tmpdir(), 'web-'));
writeFileSync(join(webDir, 'index.html'), '<!doctype html>');

const [dev, prod] = STAGES;
if (!dev || !prod) throw new Error('dev and prod stages are configured');
const stage = new NewsesStage(newApp(), 'Test', { stage: dev, webDir });
const params = Template.fromStack(stage.params);
const data = Template.fromStack(stage.data);
const app = Template.fromStack(stage.app);
const edge = Template.fromStack(stage.edge);
const release = Template.fromStack(stage.release);

describe('NewsesStage', () => {
  it('keeps generated credentials in SSM parameters rather than Secrets Manager', () => {
    for (const template of [params, data, app, edge]) {
      template.resourceCountIs('AWS::SecretsManager::Secret', 0);
    }
    params.resourceCountIs('Custom::GeneratedParameter', 4);
    for (const template of [data, app, edge]) {
      template.resourceCountIs('Custom::GeneratedParameter', 0);
    }
    expect(stage.app.dependencies).toContain(stage.params);
  });

  it('names and tags resources with the project and stage', () => {
    expect(
      [stage.params, stage.data, stage.app, stage.edge, stage.release].map((s) => s.stackName),
    ).toEqual([
      'newses-dev-params',
      'newses-dev-data',
      'newses-dev-app',
      'newses-dev-edge',
      'newses-dev-release',
    ]);
    const functions = Object.values(
      app.findResources('AWS::Lambda::Function', {
        Properties: {
          Environment: { Variables: Match.objectLike({ DB_HOST: Match.anyValue() }) },
        },
      }),
    ) as { Properties: { FunctionName: string; Tags: { Key: string; Value: string }[] } }[];
    expect(functions.map((f) => f.Properties.FunctionName).sort()).toEqual(
      ['api', 'extract', 'favicon', 'fetch', 'migrate', 'tick'].map((name) => `newses-dev-${name}`),
    );
    for (const { Properties } of functions) {
      expect(Properties.Tags).toEqual(
        expect.arrayContaining([
          { Key: 'project', Value: 'newses' },
          { Key: 'stage', Value: 'dev' },
        ]),
      );
    }
    app.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'newses-dev-feed-fetch' });
    app.hasResourceProperties('AWS::Scheduler::Schedule', { Name: 'newses-dev-auth-prune' });
    edge.hasResourceProperties('AWS::CloudFront::Function', { Name: 'newses-dev-spa-routes' });
    edge.hasResourceProperties('AWS::CloudFront::Function', {
      Name: 'newses-dev-utf8-charset',
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

/**
 * A stack shared by both pipelines, as each pipeline synthesises it. With bundling skipped, asset
 * hashes come from the construct path; real synthesis hashes the bundle, the same in both.
 */
const sharedStacks = (stackName: string) =>
  STAGES.map((config) => {
    const root = newApp();
    new PipelineStack(root, `newses-${config.name}-pipeline`, {
      env: { account: ACCOUNT, region: REGION },
      stage: config,
      webDir,
    });
    const stack = root.node
      .findAll()
      .find((c): c is Stack => Stack.isStack(c) && c.stackName === stackName);
    if (!stack) throw new Error(`No ${stackName} stack in the ${config.name} pipeline`);
    return Template.fromStack(stack);
  });

describe('Database', () => {
  const shared = new DatabaseStage(newApp(), 'Test');
  const database = Template.fromStack(shared.database);

  it('runs one small public PostgreSQL instance that requires TLS, without NAT', () => {
    database.resourceCountIs('AWS::EC2::NatGateway', 0);
    database.resourceCountIs('AWS::RDS::DBInstance', 1);
    database.hasResourceProperties('AWS::RDS::DBInstance', {
      DBInstanceIdentifier: 'newses-db',
      DBInstanceClass: 'db.t4g.micro',
      Engine: 'postgres',
      EngineVersion: '18',
      StorageType: 'gp3',
      AllocatedStorage: '20',
      StorageEncrypted: true,
      PubliclyAccessible: true,
      MultiAZ: false,
      DeletionProtection: true,
      MasterUsername: 'rss_admin',
      MasterUserPassword: '{{resolve:ssm-secure:/newses/db/master-password}}',
    });
    database.hasResource('AWS::RDS::DBInstance', { DeletionPolicy: 'Snapshot' });
    database.hasResourceProperties('AWS::RDS::DBParameterGroup', {
      Parameters: { 'rds.force_ssl': '1' },
    });
    database.hasResourceProperties('AWS::SSM::Parameter', { Name: '/newses/db/endpoint' });
    database.resourceCountIs('AWS::SecretsManager::Secret', 0);
    expect(shared.database.dependencies).toContain(shared.params);
  });

  it('is deployed the same by both pipelines', () => {
    for (const name of ['newses-db-params', 'newses-db']) {
      const [fromDev, fromProd] = sharedStacks(name).map((template) =>
        JSON.stringify(template.toJSON()).replaceAll(/"S3Key":"\w+\.zip"/g, '"S3Key":"asset"'),
      );
      expect(fromDev).toEqual(fromProd);
    }
  });

  it('gives each stage its own database and role, which migrate creates', () => {
    for (const config of STAGES) {
      const template = Template.fromStack(
        new NewsesStage(newApp(), 'Test', { stage: config, webDir }).app,
      );
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: `newses-${config.name}-api`,
        Environment: {
          Variables: Match.objectLike({
            DB_NAME: `newses_${config.name}`,
            DB_USER: `newses_${config.name}`,
          }),
        },
      });
    }
    app.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'newses-dev-migrate',
      Environment: {
        Variables: Match.objectLike({
          DB_MASTER_USER: 'rss_admin',
          DB_MASTER_PASSWORD_PARAMETER: '/newses/db/master-password',
        }),
      },
    });
    app.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'newses-dev-api',
      Environment: {
        Variables: Match.not(Match.objectLike({ DB_MASTER_PASSWORD_PARAMETER: Match.anyValue() })),
      },
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
      FunctionName: 'newses-dev-api',
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
      new NewsesStage(newApp(), 'Test', { stage: { ...dev, traceSampling: 0 }, webDir }).app,
    );
    for (const fn of Object.values(untraced.findResources('AWS::Lambda::Function'))) {
      expect(JSON.stringify(fn)).not.toContain('otel-instrument');
    }
  });

  it('names the instance only when the stage has a name', () => {
    const variables = (template: Template) =>
      Object.values(
        template.findResources('AWS::Lambda::Function', {
          Properties: {
            Environment: {
              Variables: Match.objectLike({ DB_PASSWORD_PARAMETER: Match.anyValue() }),
            },
          },
        }),
      ).map(
        (fn) =>
          (fn as { Properties: { Environment: { Variables: Record<string, unknown> } } }).Properties
            .Environment.Variables,
      );
    for (const env of variables(app)) expect(env).not.toHaveProperty('INSTANCE_NAME');
    const named = Template.fromStack(
      new NewsesStage(newApp(), 'Test', { stage: { ...dev, instanceName: 'Home' }, webDir }).app,
    );
    for (const env of variables(named)) expect(env).toMatchObject({ INSTANCE_NAME: 'Home' });
  });

  it('publishes operations alerts from tick to the stage topic', () => {
    app.hasResourceProperties('AWS::SNS::Topic', { TopicName: 'newses-dev-alerts' });
    app.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'newses-dev-tick',
      Environment: { Variables: Match.objectLike({ ALERT_TOPIC_ARN: Match.anyValue() }) },
    });
    app.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'newses-dev-api',
      Environment: {
        Variables: Match.not(Match.objectLike({ ALERT_TOPIC_ARN: Match.anyValue() })),
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
      DatabaseInput: { Name: 'newses_dev' },
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
      FunctionName: 'newses-dev-tick',
      Environment: { Variables: Match.objectLike({ ARCHIVE_ENABLED: 'true' }) },
    });
    expect(prod.archive).toBe(true);
  });

  it('reads and compacts the archive through an Athena workgroup', () => {
    data.hasResourceProperties('AWS::Athena::WorkGroup', {
      Name: 'newses-dev',
      WorkGroupConfiguration: Match.objectLike({ EnforceWorkGroupConfiguration: true }),
    });
    app.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'newses-dev-api',
      Environment: {
        Variables: Match.objectLike({
          ARCHIVE_ATHENA_WORKGROUP: 'newses-dev',
          ARCHIVE_ATHENA_DATABASE: 'newses_dev',
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
      Name: 'newses-dev-archive-compact',
      ScheduleExpression: 'cron(0 4 * * ? *)',
    });
  });
});

describe('Edge', () => {
  it('serves the SPA from a private bucket and the API paths from the HTTP API', () => {
    edge.resourceCountIs('AWS::CloudFront::OriginAccessControl', 3);
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
          Match.objectLike({ PathPattern: '/favicons/*', AllowedMethods: ['GET', 'HEAD'] }),
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

describe('Feed icons', () => {
  it('serves them from the blob bucket, cached for a year and sandboxed', () => {
    edge.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: Match.objectLike({ Name: 'newses-dev-favicons', DefaultTTL: 31536000 }),
    });
    edge.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        Name: 'newses-dev-favicon-headers',
        CustomHeadersConfig: {
          Items: [
            {
              Header: 'cache-control',
              Value: 'public, max-age=31536000, immutable',
              Override: true,
            },
          ],
        },
        SecurityHeadersConfig: Match.objectLike({
          ContentSecurityPolicy: Match.objectLike({
            ContentSecurityPolicy: Match.stringLikeRegexp('sandbox'),
          }),
        }),
      }),
    });
  });

  it('lets CloudFront read only the icons in the blob bucket', () => {
    data.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'cloudfront.amazonaws.com' },
            Action: 's3:GetObject',
            Resource: {
              'Fn::Join': [
                '',
                [Match.objectLike({ 'Fn::GetAtt': Match.anyValue() }), '/favicons/*'],
              ],
            },
            Condition: {
              ArnLike: { 'AWS:SourceArn': `arn:aws:cloudfront::${ACCOUNT}:distribution/*` },
            },
          }),
        ]),
      },
    });
  });
});

describe('Downloads', () => {
  it('keeps downloads in their own named bucket, where superseded prereleases expire', () => {
    edge.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: `newses-dev-downloads-${ACCOUNT}`,
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
      Name: 'newses-dev-downloads-index',
    });
  });
});

describe('Release', () => {
  it('releases from prerelease tags to dev, and other version tags to prod', () => {
    for (const config of STAGES) {
      const template = Template.fromStack(
        new NewsesStage(newApp(), 'Test', { stage: config, webDir }).release,
      );
      template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
        Name: `newses-${config.name}-release`,
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
    expect(policy('LinuxRole')).toContain('/newses/release/android-signing/keystore');
    expect(policy('LinuxRole')).not.toContain('windows-signing');
    expect(policy('WindowsRole')).toContain('/newses/release/windows-signing/client-secret');
    expect(policy('WindowsRole')).not.toContain('android-signing');
    expect(policy('PublishRole')).not.toContain('-signing');
    for (const [id, document] of policies) {
      expect(document.includes(`newses-dev-downloads-${ACCOUNT}`)).toBe(
        id.startsWith('PublishRole'),
      );
      expect(document).not.toContain('newses-prod');
    }
  });
});

describe('PipelineStack', () => {
  it.each(STAGES)('deploys $name from the $branch branch', (config) => {
    const root = newApp();
    const pipeline = new PipelineStack(root, `newses-${config.name}-pipeline`, {
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
    const [codePipeline] = Object.values(template.findResources('AWS::CodePipeline::Pipeline')) as {
      Properties: { Stages: { Name: string }[] };
    }[];
    const stageNames = codePipeline?.Properties.Stages.map((s) => s.Name) ?? [];
    // The stage's functions read the shared database's address when they deploy.
    expect(stageNames.indexOf('newses-db')).toBeGreaterThan(-1);
    expect(stageNames.indexOf('newses-db')).toBeLessThan(
      stageNames.indexOf(`newses-${config.name}`),
    );
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
      [
        'newses-budget',
        'newses-db',
        'newses-db-params',
        ...['app', 'data', 'edge', 'params', 'pipeline', 'release'].map(
          (part) => `newses-${config.name}-${part}`,
        ),
      ].sort(),
    );
  });
});

describe('Budget', () => {
  const budgetStacks = sharedStacks('newses-budget');

  it('deploys the same project budget from both pipelines, notifying its own topic', () => {
    app.resourceCountIs('AWS::Budgets::Budget', 0);
    const [fromDev, fromProd] = budgetStacks;
    expect(fromDev?.toJSON()).toEqual(fromProd?.toJSON());
    const budget = budgetStacks[0];
    if (!budget) throw new Error('budget stack');
    budget.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({
        BudgetName: 'newses',
        BudgetLimit: { Amount: BUDGET_USD, Unit: 'USD' },
        FilterExpression: {
          And: [
            { Tags: { Key: 'project', Values: ['newses'], MatchOptions: ['EQUALS'] } },
            { Not: { Dimensions: { Key: 'SERVICE', Values: BUILD_SERVICES } } },
          ],
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
    budget.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: {
        Statement: [Match.objectLike({ Principal: { Service: 'budgets.amazonaws.com' } })],
      },
    });
    // Tagged with the project only, so neither stage claims it.
    budget.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'newses-budget',
      Tags: [{ Key: 'project', Value: 'newses' }],
    });
  });
});
