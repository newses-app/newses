import type { ApiServices } from '../api/app.ts';
import { createAuthServices } from '../core/auth/index.ts';
import { createEntryServices } from '../core/entries/index.ts';
import type { FeedDeps } from '../core/feeds/index.ts';
import { createFeedServices } from '../core/feeds/index.ts';
import { createOpsServices } from '../core/ops/index.ts';
import type { Fetcher } from '../core/feeds/http.ts';
import { PrefsService } from '../core/prefs.ts';
import type { Db } from '../db/client.ts';
import { silentLogger, TEST_APP_SECRET, TEST_OPS_SETTINGS, testFeedDeps } from './fakes.ts';

/** Every API service over `db`, with fake adapters unless overridden. */
export function createTestServices(
  db: Db,
  fetcher: Fetcher,
  overrides: Partial<FeedDeps> = {},
): ApiServices {
  const deps = testFeedDeps(db, fetcher, overrides);
  return {
    ...createAuthServices(db, TEST_APP_SECRET),
    feeds: createFeedServices(deps),
    entries: createEntryServices(db, deps.realtime),
    prefs: new PrefsService(db),
    realtime: deps.realtime,
    ops: createOpsServices({ db, logger: silentLogger, settings: TEST_OPS_SETTINGS }),
  };
}
