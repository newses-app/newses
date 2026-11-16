import { createAuthServices } from '../../core/auth/index.ts';
import { EntryService } from '../../core/entries/entries.ts';
import { SyncService } from '../../core/entries/sync.ts';
import { createFeedServices } from '../../core/feeds/index.ts';
import { DigestService } from '../../core/mail/digest-service.ts';
import { PrefsService } from '../../core/prefs.ts';
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
  digest: new DigestService({
    db,
    mailer: feedDeps.mailer,
    prefs: new PrefsService(db),
    entries: new EntryService(db, feedDeps.realtime),
    publicUrl: config.publicUrl,
    unsubscribeKey: feedDeps.keys['digest-unsubscribe'],
    logger,
  }),
  ops,
  archive,
  logger,
});
