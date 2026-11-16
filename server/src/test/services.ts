import type { ApiServices } from '../api/app.ts';
import { createAuthServices } from '../core/auth/index.ts';
import { createEntryServices } from '../core/entries/index.ts';
import type { FeedDeps } from '../core/feeds/index.ts';
import { createFeedServices } from '../core/feeds/index.ts';
import { createMailServices } from '../core/mail/index.ts';
import { createOpsServices } from '../core/ops/index.ts';
import type { Fetcher } from '../core/feeds/http.ts';
import { PrefsService } from '../core/prefs.ts';
import { ThemeService } from '../core/themes.ts';
import type { Db } from '../db/client.ts';
import { silentLogger, TEST_APP_SECRET, TEST_OPS_SETTINGS, testFeedDeps } from './fakes.ts';

/** The public URL test services link scheduled mail to. */
export const TEST_PUBLIC_URL = 'https://reader.example';

/** Every API service over `db`, with fake adapters unless overridden. */
export function createTestServices(
  db: Db,
  fetcher: Fetcher,
  overrides: Partial<FeedDeps> = {},
): ApiServices {
  const deps = testFeedDeps(db, fetcher, overrides);
  const feeds = createFeedServices(deps);
  const prefs = new PrefsService(db);
  const entries = createEntryServices(db, deps.realtime);
  return {
    ...createAuthServices(db, TEST_APP_SECRET),
    feeds,
    entries,
    prefs,
    mail: createMailServices({
      db,
      mailer: deps.mailer,
      limits: feeds.rateLimits,
      prefs,
      entries: entries.entries,
      images: feeds.images,
      logger: deps.logger,
      publicUrl: TEST_PUBLIC_URL,
      unsubscribeKey: deps.keys['digest-unsubscribe'],
    }),
    themes: new ThemeService(db),
    realtime: deps.realtime,
    ops: createOpsServices({ db, logger: silentLogger, settings: TEST_OPS_SETTINGS }),
  };
}
