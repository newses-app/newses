import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as targets from 'aws-cdk-lib/aws-scheduler-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as triggers from 'aws-cdk-lib/triggers';
import type { Construct } from 'constructs';
import { BUILD_VERSION, REPO_ROOT, type StageConfig } from './config.ts';
import {
  ADOT_LAYER_ARN,
  DB_ENDPOINT_PARAMETER,
  DB_MASTER_PASSWORD_PARAMETER,
  DB_MASTER_USER,
  dbName,
  PROJECT,
  resourceName,
} from './deploy-config.ts';
import type { ParamsStack } from './params-stack.ts';

const LAMBDA_DIR = join(REPO_ROOT, 'server/src/entrypoints/lambda');
const ARGON2_VERSION = (
  JSON.parse(readFileSync(join(REPO_ROOT, 'server/package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  }
).dependencies['@node-rs/argon2'];

/** Feed dispatch cadence; other schedules fall on dispatch times. */
const DISPATCH_MINUTES = 30;

export interface AppStackProps extends StackProps {
  stage: StageConfig;
  params: ParamsStack;
  blobs: s3.Bucket;
  archive: { database: string; workgroup: string };
}

/**
 * ADOT settings: our spans and AWS SDK calls, sampled by trace id at the stage's rate and sent to
 * X-Ray through Lambda's local endpoint, which works without active tracing. Lambda's `Sampled=0`
 * header without active tracing would drop every span under a parent-based sampler. undici is never
 * instrumented, so feed requests carry no trace headers; `http` would only duplicate the AWS SDK
 * spans. Application Signals stays off, as it bills per signal and creates metrics.
 */
const tracingEnvironment = (stage: StageConfig, name: string) => ({
  AWS_LAMBDA_EXEC_WRAPPER: '/opt/otel-instrument',
  OTEL_TRACES_SAMPLER: 'traceidratio',
  OTEL_TRACES_SAMPLER_ARG: String(stage.traceSampling),
  OTEL_AWS_APPLICATION_SIGNALS_ENABLED: 'false',
  // The wrapper always appends `http` to the enabled list, so it is disabled explicitly.
  OTEL_NODE_ENABLED_INSTRUMENTATIONS: 'aws-lambda,aws-sdk',
  OTEL_NODE_DISABLED_INSTRUMENTATIONS: 'http',
  OTEL_SERVICE_NAME: `${PROJECT}-${name}`,
  OTEL_RESOURCE_ATTRIBUTES: `deployment.environment.name=${stage.name},service.version=${BUILD_VERSION}`,
});

/** Lambdas behind an HTTP API, SQS job queues, and the schedules that dispatch feeds. */
export class AppStack extends Stack {
  readonly api: apigw.HttpApi;
  /** Operations alerts; subscribe an email address to receive them. */
  readonly alerts: sns.Topic;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const { stage, params, blobs, archive } = props;
    const { dbPassword, adminPassword, originHeader, appSecret } = params;

    const fetchDlq = new sqs.Queue(this, 'FeedFetchDlq', {
      queueName: resourceName(stage, 'feed-fetch-dlq'),
      retentionPeriod: Duration.days(14),
    });
    const fetchQueue = new sqs.Queue(this, 'FeedFetchQueue', {
      queueName: resourceName(stage, 'feed-fetch'),
      visibilityTimeout: Duration.minutes(30),
      deadLetterQueue: { queue: fetchDlq, maxReceiveCount: 2 },
    });
    const faviconDlq = new sqs.Queue(this, 'FeedFaviconDlq', {
      queueName: resourceName(stage, 'feed-favicon-dlq'),
      retentionPeriod: Duration.days(14),
    });
    const faviconQueue = new sqs.Queue(this, 'FeedFaviconQueue', {
      queueName: resourceName(stage, 'feed-favicon'),
      visibilityTimeout: Duration.minutes(10),
      deadLetterQueue: { queue: faviconDlq, maxReceiveCount: 2 },
    });

    const extractDlq = new sqs.Queue(this, 'EntryExtractDlq', {
      queueName: resourceName(stage, 'entry-extract-dlq'),
      retentionPeriod: Duration.days(14),
    });
    const extractQueue = new sqs.Queue(this, 'EntryExtractQueue', {
      queueName: resourceName(stage, 'entry-extract'),
      visibilityTimeout: Duration.minutes(20),
      deadLetterQueue: { queue: extractDlq, maxReceiveCount: 2 },
    });

    const adotLayer =
      stage.traceSampling > 0
        ? lambda.LayerVersion.fromLayerVersionArn(this, 'AdotLayer', ADOT_LAYER_ARN)
        : undefined;

    const fn = (name: string, options: { timeout: Duration; memorySize?: number }) => {
      const functionName = resourceName(stage, name);
      const handler = new nodejs.NodejsFunction(this, `${name}Function`, {
        functionName,
        entry: join(LAMBDA_DIR, `${name}.ts`),
        projectRoot: REPO_ROOT,
        depsLockFilePath: join(REPO_ROOT, 'pnpm-lock.yaml'),
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: options.memorySize ?? 512,
        timeout: options.timeout,
        logGroup: new logs.LogGroup(this, `${name}Logs`, {
          logGroupName: `/aws/lambda/${functionName}`,
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: stage.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
        }),
        environment: {
          // The shared instance is deployed by another pipeline stage, so it is not referenced.
          DB_HOST: ssm.StringParameter.valueForStringParameter(this, DB_ENDPOINT_PARAMETER),
          DB_PORT: '5432',
          DB_NAME: dbName(stage),
          DB_USER: dbName(stage),
          DB_PASSWORD_PARAMETER: dbPassword.parameterName,
          APP_SECRET_PARAMETER: appSecret.parameterName,
          // CloudFront does not forward the viewer's Host, so public links need the domain.
          PUBLIC_URL: `https://${stage.domainName}`,
          COMPAT_TRACE: String(stage.compatTrace),
          ARCHIVE_ENABLED: String(stage.archive),
          ARCHIVE_ATHENA_WORKGROUP: archive.workgroup,
          ARCHIVE_ATHENA_DATABASE: archive.database,
          NEWSES_VERSION: BUILD_VERSION,
          BLOB_BUCKET: blobs.bucketName,
          FEED_FETCH_QUEUE_URL: fetchQueue.queueUrl,
          FEED_FAVICON_QUEUE_URL: faviconQueue.queueUrl,
          ENTRY_EXTRACT_QUEUE_URL: extractQueue.queueUrl,
          // The Lambda runtime's CA bundle includes the RDS certificate authorities.
          NODE_EXTRA_CA_CERTS: '/var/runtime/ca-cert.pem',
          NODE_OPTIONS: '--enable-source-maps',
          ...(adotLayer && tracingEnvironment(stage, name)),
        },
        ...(adotLayer && { layers: [adotLayer] }),
        bundling: {
          format: nodejs.OutputFormat.ESM,
          target: 'node24',
          mainFields: ['module', 'main'],
          sourceMap: true,
          banner:
            "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
          // The runtime provides the AWS SDK; argon2 is native and installed for the target below.
          // DuckDB reads the archive on Docker only, so functions never load it.
          externalModules: ['@aws-sdk/*', '@node-rs/argon2', '@duckdb/*'],
          commandHooks: {
            beforeBundling: () => [],
            beforeInstall: () => [],
            afterBundling: (input, output) => [
              // Migrations are read from the folder next to the bundle.
              `cp -r ${input}/server/src/db/migrations ${output}/migrations`,
              // A package.json of its own stops npm from resolving the enclosing workspace.
              `cd ${output} && echo '{}' > package.json && npm install --no-save --no-package-lock --os=linux --cpu=arm64 --libc=glibc @node-rs/argon2@${ARGON2_VERSION ?? 'latest'}`,
            ],
          },
        },
      });
      dbPassword.grantRead(handler);
      appSecret.grantRead(handler);
      blobs.grantReadWrite(handler);
      fetchQueue.grantSendMessages(handler);
      faviconQueue.grantSendMessages(handler);
      extractQueue.grantSendMessages(handler);
      if (adotLayer) {
        handler.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
            resources: ['*'],
          }),
        );
      }
      return handler;
    };

    const api = fn('api', { timeout: Duration.seconds(29), memorySize: 1024 });
    api.addEnvironment('ORIGIN_HEADER_PARAMETER', originHeader.parameterName);
    // X-Forwarded-For arrives as `<client>, <CloudFront>`: CloudFront appends the viewer, then API
    // Gateway appends CloudFront, which is also the request's source. Two hops reach the viewer.
    api.addEnvironment('TRUST_PROXY', '2');
    originHeader.grantRead(api);
    this.api = new apigw.HttpApi(this, 'HttpApi', {
      apiName: resourceName(stage),
      defaultIntegration: new HttpLambdaIntegration('Api', api),
    });

    this.alerts = new sns.Topic(this, 'Alerts', { topicName: resourceName(stage, 'alerts') });

    const tick = fn('tick', { timeout: Duration.minutes(5) });
    // Operations alerts are checked after each dispatch.
    tick.addEnvironment('ALERT_TOPIC_ARN', this.alerts.topicArn);
    this.alerts.grantPublish(tick);
    const tickSchedule = (name: string, expression: string, task: string) =>
      new scheduler.Schedule(this, `${name}Schedule`, {
        scheduleName: resourceName(stage, task.replace('.', '-')),
        schedule: scheduler.ScheduleExpression.expression(expression),
        target: new targets.LambdaInvoke(tick, {
          input: scheduler.ScheduleTargetInput.fromObject({ task }),
          retryAttempts: 0,
        }),
      });
    tickSchedule('Dispatch', `cron(0/${String(DISPATCH_MINUTES)} * * * ? *)`, 'dispatch');
    tickSchedule('Purge', 'cron(0 */6 * * ? *)', 'purge');
    tickSchedule('AuthPrune', 'cron(0 * * * ? *)', 'auth.prune');
    tickSchedule('ArchiveCompact', 'cron(0 4 * * ? *)', 'archive.compact');

    // Archive reads (api) and compaction (tick) query Athena over the Glue table; the bucket
    // grants above cover the data and query results.
    const athenaQueries = [
      new iam.PolicyStatement({
        actions: [
          'athena:StartQueryExecution',
          'athena:GetQueryExecution',
          'athena:GetQueryResults',
          'athena:StopQueryExecution',
        ],
        resources: [
          this.formatArn({
            service: 'athena',
            resource: 'workgroup',
            resourceName: archive.workgroup,
          }),
        ],
      }),
      new iam.PolicyStatement({
        actions: ['glue:GetDatabase', 'glue:GetTable', 'glue:GetPartition', 'glue:GetPartitions'],
        resources: [
          this.formatArn({ service: 'glue', resource: 'catalog' }),
          this.formatArn({ service: 'glue', resource: 'database', resourceName: archive.database }),
          this.formatArn({
            service: 'glue',
            resource: 'table',
            resourceName: `${archive.database}/*`,
          }),
        ],
      }),
    ];
    for (const statement of athenaQueries) {
      api.addToRolePolicy(statement);
      tick.addToRolePolicy(statement);
    }

    const fetch = fn('fetch', { timeout: Duration.minutes(15) });
    // One host's batch per invocation; at most 8 hosts at once.
    fetch.addEventSource(
      new SqsEventSource(fetchQueue, {
        batchSize: 1,
        maxConcurrency: 8,
        reportBatchItemFailures: true,
      }),
    );
    const favicon = fn('favicon', { timeout: Duration.minutes(2) });
    favicon.addEventSource(
      new SqsEventSource(faviconQueue, {
        batchSize: 5,
        maxConcurrency: 2,
        reportBatchItemFailures: true,
      }),
    );

    const extract = fn('extract', { timeout: Duration.minutes(10) });
    // One feed source's pending entries per invocation, fetched one after another.
    extract.addEventSource(
      new SqsEventSource(extractQueue, {
        batchSize: 1,
        maxConcurrency: 2,
        reportBatchItemFailures: true,
      }),
    );

    const migrate = fn('migrate', { timeout: Duration.minutes(10) });
    migrate.addEnvironment('ADMIN_LOGIN', 'admin');
    migrate.addEnvironment('ADMIN_PASSWORD_PARAMETER', adminPassword.parameterName);
    adminPassword.grantRead(migrate);
    // Creates the stage's role and database on the shared instance before migrating.
    migrate.addEnvironment('DB_MASTER_USER', DB_MASTER_USER);
    migrate.addEnvironment('DB_MASTER_PASSWORD_PARAMETER', DB_MASTER_PASSWORD_PARAMETER);
    ssm.StringParameter.fromSecureStringParameterAttributes(this, 'DbMasterPassword', {
      parameterName: DB_MASTER_PASSWORD_PARAMETER,
    }).grantRead(migrate);
    // Runs on every deployment that changes the migrate bundle, before the other functions update.
    new triggers.Trigger(this, 'Migrate', {
      handler: migrate,
      timeout: Duration.minutes(10),
      executeOnHandlerChange: true,
      executeBefore: [api, tick, fetch, favicon],
    });
  }
}
