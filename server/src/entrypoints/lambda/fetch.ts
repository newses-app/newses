import { createFeedServices } from '../../core/feeds/index.ts';
import type { Jobs } from '../../core/jobs.ts';
import { createLambdaRuntime, sqsHandler } from './runtime.ts';

const runtime = await createLambdaRuntime('fetch');
const feeds = createFeedServices(runtime.feedDeps);

export const handler = sqsHandler(runtime, 'feed.fetch', ({ feedSourceIds }: Jobs['feed.fetch']) =>
  feeds.updater.updateMany(feedSourceIds),
);
