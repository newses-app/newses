import { createFeedServices } from '../../core/feeds/index.ts';
import type { Jobs } from '../../core/jobs.ts';
import { createLambdaRuntime, sqsHandler } from './runtime.ts';

const { logger, feedDeps } = await createLambdaRuntime('favicon');
const feeds = createFeedServices(feedDeps);

export const handler = sqsHandler(logger, ({ feedSourceId }: Jobs['feed.favicon']) =>
  feeds.favicons.refresh(feedSourceId),
);
