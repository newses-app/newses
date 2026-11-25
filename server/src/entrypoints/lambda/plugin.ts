import { EntryService } from '../../core/entries/entries.ts';
import { createFeedServices } from '../../core/feeds/index.ts';
import { DigestService } from '../../core/mail/digest-service.ts';
import { PrefsService } from '../../core/prefs.ts';
import { createProcessPlugins } from '../feed-deps.ts';
import { createLambdaRuntime, sqsHandler } from './runtime.ts';

/** How long one invocation spends on deliveries, within the function's timeout. */
const DISPATCH_BUDGET_MS = 3 * 60 * 1000;
/** How long it spends starting test digests, each taking plugins up to a minute. */
const TESTS_BUDGET_MS = 30_000;

const runtime = await createLambdaRuntime('plugin');
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
  composer: plugins.digest,
});

/** Sends the test digests asked for, runs plugins' due deliveries, then queues a wake for the next. */
export const handler = sqsHandler(runtime, 'plugin.dispatch', async () => {
  const tested = await digest.sendTests({ deadline: Date.now() + TESTS_BUDGET_MS });
  if (tested > 0) logger.info({ tested }, 'Sent test digests');
  const ran = await plugins.events.dispatch(Date.now() + DISPATCH_BUDGET_MS);
  logger.debug({ ran }, 'Ran plugin deliveries');
  await runtime.wakePlugins();
});
