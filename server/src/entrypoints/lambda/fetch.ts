import { createFeedServices } from '../../core/feeds/index.ts';
import type { Jobs } from '../../core/jobs.ts';
import { createLambdaRuntime, sqsHandler } from './runtime.ts';

const { logger, feedDeps } = await createLambdaRuntime('fetch');
const feeds = createFeedServices(feedDeps);

export const handler = sqsHandler(logger, ({ feedSourceIds }: Jobs['feed.fetch']) =>
  feeds.updater.updateMany(feedSourceIds),
);
