import awsLambdaFastify from '@fastify/aws-lambda';
import { buildApp } from '../../api/app.ts';
import { createAuthServices } from '../../core/auth/index.ts';
import { createEntryServices } from '../../core/entries/index.ts';
import { createFeedServices } from '../../core/feeds/index.ts';
import { createMailServices } from '../../core/mail/index.ts';
import { PrefsService } from '../../core/prefs.ts';
import { ThemeService } from '../../core/themes.ts';
import { binaryResponse, createApiHandler } from './api-handler.ts';
import { createLambdaRuntime, readParameter, trackPoolUse } from './runtime.ts';

const { config, logger, pool, db, feedDeps, ops, archive } = await createLambdaRuntime('api');
const feeds = createFeedServices(feedDeps);
const prefs = new PrefsService(db);
const entries = createEntryServices(db, feedDeps.realtime, archive);

const app = buildApp({
  logger,
  trustProxy: config.http.trustProxy,
  version: config.version,
  instanceName: config.instanceName,
  sourceUrl: config.sourceUrl,
  publicUrl: config.publicUrl,
  pushDistributorUrl: config.push.distributorUrl,
  compatTrace: config.compatTrace,
  // Lambda responses are buffered, so event streams cannot be held open; clients poll.
  events: false,
  services: {
    ...createAuthServices(db, config.appSecret),
    feeds,
    entries,
    prefs,
    mail: createMailServices({
      db,
      mailer: feedDeps.mailer,
      limits: feeds.rateLimits,
      prefs,
      entries: entries.entries,
      images: feeds.images,
      logger,
    }),
    themes: new ThemeService(db),
    realtime: feedDeps.realtime,
    ops,
  },
  healthChecks: {
    db: async () => {
      await pool.query('SELECT 1');
    },
  },
});

const proxy = awsLambdaFastify(app, { enforceBase64: binaryResponse });
await app.ready();

// CloudFront adds the origin secret, so requests to the API endpoint that bypass it are refused.
export const handler = createApiHandler({
  proxy,
  originSecret: await readParameter('ORIGIN_HEADER_PARAMETER'),
  database: trackPoolUse(pool),
  flush: () => Promise.all([ops.recorder.flush(), ops.audit.settle()]),
});
