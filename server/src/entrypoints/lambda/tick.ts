import { createAuthServices } from '../../core/auth/index.ts';
import { SyncService } from '../../core/entries/sync.ts';
import { createFeedServices } from '../../core/feeds/index.ts';
import { createTickHandler } from '../scheduled-tasks.ts';
import { createLambdaRuntime } from './runtime.ts';

const { config, logger, db, feedDeps, ops, archive } = await createLambdaRuntime('tick');
const { sessions, throttle } = createAuthServices(db, config.appSecret);

export type { TickEvent } from '../scheduled-tasks.ts';

export const handler = createTickHandler({
  feeds: createFeedServices(feedDeps),
  sessions,
  throttle,
  sync: new SyncService(db),
  ops,
  archive,
  logger,
});
