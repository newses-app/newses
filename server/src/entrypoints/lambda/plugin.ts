import { createFeedServices } from '../../core/feeds/index.ts';
import { createProcessPlugins } from '../feed-deps.ts';
import { createLambdaRuntime, sqsHandler } from './runtime.ts';

/** How long one invocation spends on deliveries, within the function's timeout. */
const DISPATCH_BUDGET_MS = 3 * 60 * 1000;

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

/** Runs plugins' due deliveries, then queues a wake for the next. */
export const handler = sqsHandler(runtime, 'plugin.dispatch', async () => {
  const ran = await plugins.events.dispatch(Date.now() + DISPATCH_BUDGET_MS);
  logger.debug({ ran }, 'Ran plugin deliveries');
  await runtime.wakePlugins();
});
