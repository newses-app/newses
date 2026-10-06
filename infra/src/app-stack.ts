import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Duration, RemovalPolicy, Stack, type StackProps, Token } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as rds from 'aws-cdk-lib/aws-rds';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as targets from 'aws-cdk-lib/aws-scheduler-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as triggers from 'aws-cdk-lib/triggers';
import type { Construct } from 'constructs';
import { REPO_ROOT, resourceName, type StageConfig } from './config.ts';
import type { ParamsStack } from './params-stack.ts';

const LAMBDA_DIR = join(REPO_ROOT, 'server/src/entrypoints/lambda');
const ARGON2_VERSION = (
  JSON.parse(readFileSync(join(REPO_ROOT, 'server/package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  }
).dependencies['@node-rs/argon2'];

/** Feed dispatch cadence; other schedules fall on dispatch times so the database wakes once. */
const DISPATCH_MINUTES = 30;

export interface AppStackProps extends StackProps {
  stage: StageConfig;
  cluster: rds.DatabaseCluster;
  params: ParamsStack;
  blobs: s3.Bucket;
}

/** Lambdas behind an HTTP API, SQS job queues, and the schedules that dispatch feeds. */
export class AppStack extends Stack {
  readonly api: apigw.HttpApi;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const { stage, cluster, params, blobs } = props;
    const { dbPassword, adminPassword, originHeader } = params;

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
          DB_HOST: cluster.clusterEndpoint.hostname,
          DB_PORT: Token.asString(cluster.clusterEndpoint.port),
          DB_NAME: 'rss_reader',
          DB_USER: 'rss_reader',
          DB_PASSWORD_PARAMETER: dbPassword.parameterName,
          BLOB_BUCKET: blobs.bucketName,
          FEED_FETCH_QUEUE_URL: fetchQueue.queueUrl,
          FEED_FAVICON_QUEUE_URL: faviconQueue.queueUrl,
          // The Lambda runtime's CA bundle includes the RDS certificate authorities.
          NODE_EXTRA_CA_CERTS: '/var/runtime/ca-cert.pem',
          NODE_OPTIONS: '--enable-source-maps',
        },
        bundling: {
          format: nodejs.OutputFormat.ESM,
          target: 'node24',
          mainFields: ['module', 'main'],
          sourceMap: true,
          banner:
            "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
          // The runtime provides the AWS SDK; argon2 is native and installed for the target below.
          externalModules: ['@aws-sdk/*', '@node-rs/argon2'],
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
      blobs.grantReadWrite(handler);
      fetchQueue.grantSendMessages(handler);
      faviconQueue.grantSendMessages(handler);
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

    const tick = fn('tick', { timeout: Duration.minutes(5) });
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

    const migrate = fn('migrate', { timeout: Duration.minutes(10) });
    migrate.addEnvironment('ADMIN_LOGIN', 'admin');
    migrate.addEnvironment('ADMIN_PASSWORD_PARAMETER', adminPassword.parameterName);
    adminPassword.grantRead(migrate);
    // Runs on every deployment that changes the migrate bundle, before the other functions update.
    new triggers.Trigger(this, 'Migrate', {
      handler: migrate,
      timeout: Duration.minutes(10),
      executeOnHandlerChange: true,
      executeBefore: [api, tick, fetch, favicon],
    });
  }
}
