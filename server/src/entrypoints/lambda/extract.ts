import { createFeedServices } from '../../core/feeds/index.ts';
import type { Jobs } from '../../core/jobs.ts';
import { createLambdaRuntime, sqsHandler } from './runtime.ts';

const { logger, feedDeps } = await createLambdaRuntime('extract');
const feeds = createFeedServices(feedDeps);

export const handler = sqsHandler(logger, (data: Jobs['entry.extract']) =>
  feeds.fullText.runJob(data),
);
