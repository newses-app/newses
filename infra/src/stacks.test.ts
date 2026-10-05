import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ACCOUNT, CERTIFICATE_ARN, REGION, STAGES } from './config.ts';
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
const data = Template.fromStack(stage.data);
const app = Template.fromStack(stage.app);
const edge = Template.fromStack(stage.edge);

describe('RssReaderStage', () => {
  it('keeps generated credentials in SSM parameters rather than Secrets Manager', () => {
    for (const template of [data, app, edge]) {
      template.resourceCountIs('AWS::SecretsManager::Secret', 0);
    }
    data.resourceCountIs('Custom::GeneratedParameter', 1);
    app.resourceCountIs('Custom::GeneratedParameter', 2);
    data.hasResourceProperties('AWS::RDS::DBCluster', {
      MasterUserPassword: '{{resolve:ssm-secure:/rss-reader/dev/db-password}}',
    });
  });

  it('names and tags resources with the project and stage', () => {
    expect([stage.data, stage.app, stage.edge].map((s) => s.stackName)).toEqual([
      'rss-reader-dev-data',
      'rss-reader-dev-app',
      'rss-reader-dev-edge',
    ]);
    const functions = Object.values(
      app.findResources('AWS::Lambda::Function', {
        Properties: {
          Environment: { Variables: Match.objectLike({ DB_HOST: Match.anyValue() }) },
        },
      }),
    ) as { Properties: { FunctionName: string; Tags: { Key: string; Value: string }[] } }[];
    expect(functions.map((f) => f.Properties.FunctionName).sort()).toEqual(
      ['api', 'favicon', 'fetch', 'migrate', 'tick'].map((name) => `rss-reader-dev-${name}`),
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
    expect(functions).toHaveLength(5);
    for (const { Properties } of functions) {
      expect(Properties.Runtime).toBe('nodejs24.x');
      expect(Properties.Architectures).toEqual(['arm64']);
      expect(Properties.VpcConfig).toBeUndefined();
    }
  });

  it('fetches at most 8 hosts at once and schedules dispatch, purge, and prune', () => {
    app.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 1,
      ScalingConfig: { MaximumConcurrency: 8 },
    });
    app.resourceCountIs('AWS::Scheduler::Schedule', 3);
    app.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'cron(0/30 * * * ? *)',
    });
  });
});

describe('Edge', () => {
  it('serves the SPA from a private bucket and the API paths from the HTTP API', () => {
    edge.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    edge.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: [dev.domainName],
        ViewerCertificate: Match.objectLike({ AcmCertificateArn: CERTIFICATE_ARN }),
        CacheBehaviors: API_PATHS.map((path) => Match.objectLike({ PathPattern: path })),
      }),
    });
    edge.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: `${dev.domainName}.`,
      Type: 'A',
    });
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
    const buildSpecs = Object.values(template.findResources('AWS::CodeBuild::Project')).map(
      (project) =>
        JSON.parse(
          (project as { Properties: { Source: { BuildSpec: string } } }).Properties.Source
            .BuildSpec,
        ) as {
          phases: {
            install?: { 'runtime-versions'?: Record<string, unknown>; commands?: string[] };
          };
        },
    );
    const synth = buildSpecs.find((spec) =>
      spec.phases.install?.commands?.includes('corepack enable'),
    );
    expect(synth?.phases.install?.['runtime-versions']).toEqual({ nodejs: 24 });
    const stackNames = root.node
      .findAll()
      .filter((c): c is Stack => Stack.isStack(c))
      .map((s) => s.stackName);
    expect(stackNames.sort()).toEqual(
      ['app', 'data', 'edge', 'pipeline'].map((part) => `rss-reader-${config.name}-${part}`),
    );
  });
});
