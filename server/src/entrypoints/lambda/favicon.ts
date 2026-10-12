import { createFeedServices } from '../../core/feeds/index.ts';
import type { Jobs } from '../../core/jobs.ts';
import { createLambdaRuntime, sqsHandler } from './runtime.ts';

const runtime = await createLambdaRuntime('favicon');
const feeds = createFeedServices(runtime.feedDeps);

export const handler = sqsHandler(
  runtime,
  'feed.favicon',
  ({ feedSourceId }: Jobs['feed.favicon']) => feeds.favicons.refresh(feedSourceId),
);
