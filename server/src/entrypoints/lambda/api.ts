import { timingSafeEqual } from 'node:crypto';
import awsLambdaFastify from '@fastify/aws-lambda';
import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { buildApp } from '../../api/app.ts';
import { createAuthServices } from '../../core/auth/index.ts';
import { createEntryServices } from '../../core/entries/index.ts';
import { createFeedServices } from '../../core/feeds/index.ts';
import { PrefsService } from '../../core/prefs.ts';
import { createLambdaRuntime, readParameter } from './runtime.ts';

const { config, logger, pool, db, feedDeps } = await createLambdaRuntime('api');

const app = buildApp({
  logger,
  trustProxy: config.http.trustProxy,
  // Lambda responses are buffered, so event streams cannot be held open; clients poll.
  events: false,
  services: {
    ...createAuthServices(db, config.appSecret),
    feeds: createFeedServices(feedDeps),
    entries: createEntryServices(db, feedDeps.realtime),
    prefs: new PrefsService(db),
    realtime: feedDeps.realtime,
  },
  healthChecks: {
    db: async () => {
      await pool.query('SELECT 1');
    },
  },
});

const proxy = awsLambdaFastify(app, {
  // Favicons are binary; JSON and text stay plain.
  enforceBase64: (response) =>
    /^image\//.test(response.headers['content-type'] ?? '') ||
    response.headers['content-encoding'] !== undefined,
});
await app.ready();

// CloudFront adds the origin secret, so requests to the API endpoint that bypass it are refused.
const originSecret = Buffer.from(await readParameter('ORIGIN_HEADER_PARAMETER'));

function fromCloudFront(event: APIGatewayProxyEventV2): boolean {
  const given = Buffer.from(event.headers['x-origin-verify'] ?? '');
  return given.length === originSecret.length && timingSafeEqual(given, originSecret);
}

export const handler = async (event: APIGatewayProxyEventV2, context: Context) =>
  fromCloudFront(event) ? proxy(event, context) : { statusCode: 403, body: '' };
