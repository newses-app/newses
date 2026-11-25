import { EntryService } from '../../core/entries/entries.ts';
import { createFeedServices } from '../../core/feeds/index.ts';
import type { Jobs } from '../../core/jobs.ts';
import { DigestService } from '../../core/mail/digest-service.ts';
import { PrefsService } from '../../core/prefs.ts';
import { createProcessPlugins } from '../feed-deps.ts';
import { createLambdaRuntime, sqsHandler } from './runtime.ts';

const runtime = await createLambdaRuntime('digest');
const { config, logger, db, feedDeps, ops } = runtime;
const plugins = createProcessPlugins({
  config,
  registry: runtime.plugins,
  db,
  keys: feedDeps.keys,
  logger,
  ops: ops.recorder,
  polite: createFeedServices(feedDeps).polite,
});
const digest = new DigestService({
  db,
  mailer: feedDeps.mailer,
  prefs: new PrefsService(db),
  entries: new EntryService(db, feedDeps.realtime),
  publicUrl: config.publicUrl,
  unsubscribeKey: feedDeps.keys['digest-unsubscribe'],
  logger,
  queue: feedDeps.queue,
  composer: plugins.digest,
});

/** Sends one user's digest, due or a test, with the plugins' additions. */
export const handler = sqsHandler(runtime, 'digest.send', async (job: Jobs['digest.send']) => {
  await digest.runJob(job);
});
