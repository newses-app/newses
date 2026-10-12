import { createFeedServices } from '../../core/feeds/index.ts';
import type { Jobs } from '../../core/jobs.ts';
import { createLambdaRuntime, sqsHandler } from './runtime.ts';

const runtime = await createLambdaRuntime('extract');
const feeds = createFeedServices(runtime.feedDeps);

export const handler = sqsHandler(runtime, 'entry.extract', (data: Jobs['entry.extract']) =>
  feeds.fullText.runJob(data),
);
