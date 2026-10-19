import type { Db } from '../../db/client.ts';
import { CategoryService } from '../categories.ts';
import type { Keys } from '../crypto.ts';
import { UserRateLimiter } from '../rate-limit.ts';
import type { FeedSettings } from '../config.ts';
import type { Jobs } from '../jobs.ts';
import type { ArchiveWriter, BlobStore, JobQueue, Logger, Realtime } from '../ports.ts';
import { FeedDebugger } from './debugger.ts';
import { FaviconService, IconTokens } from './favicons.ts';
import { FullTextService } from './fulltext.ts';
import { HostLimiter } from './host-limiter.ts';
import { ImageProxy } from './images.ts';
import { HostRuleService } from './host-rules.ts';
import type { Fetcher } from './http.ts';
import { Ingester } from './ingest.ts';
import { OpmlService } from './opml.ts';
import { PoliteFetcher } from './polite-fetcher.ts';
import { PublishedPageService } from './published-pages.ts';
import { Purger } from './purge.ts';
import { SubscriptionService } from './subscriptions.ts';
import { FeedUpdater } from './updater.ts';

export interface FeedDeps {
  db: Db;
  fetcher: Fetcher;
  queue: JobQueue<Jobs>;
  realtime: Realtime;
  blobs: BlobStore;
  /** Where purge writes entries before deleting them; null when the archive is off. */
  archive: ArchiveWriter | null;
  settings: FeedSettings;
  logger: Logger;
  /** Keys derived from APP_SECRET. */
  keys: Keys;
  /** Minimum milliseconds between request starts to one host (tests set 0). */
  hostGapMs?: number;
}

/** Concurrent requests per host, and minimum milliseconds between their starts. */
const PER_HOST_CONCURRENCY = 2;
const PER_HOST_GAP_MS = 1000;

export function createFeedServices(deps: FeedDeps) {
  const { db, blobs, settings, logger } = deps;
  // Every service fetches through one limiter, so together they respect each host's limits.
  const hosts = new HostLimiter(PER_HOST_CONCURRENCY, deps.hostGapMs ?? PER_HOST_GAP_MS);
  const fetcher = new PoliteFetcher({ db, fetcher: deps.fetcher, hosts });
  const limits = new UserRateLimiter(db);
  const ingester = new Ingester(db, deps.realtime, settings);
  const fullText = new FullTextService({ db, fetcher, queue: deps.queue, logger, limits });
  const updater = new FeedUpdater({
    fullText,
    db,
    fetcher,
    ingester,
    queue: deps.queue,
    settings,
    logger,
  });
  const categories = new CategoryService(db);
  const subscriptions = new SubscriptionService({ db, fetcher, ingester, updater, limits });
  return {
    categories,
    subscriptions,
    feedDebugger: new FeedDebugger({ db, fetcher, limits, subscriptions }),
    opml: new OpmlService(db, categories, subscriptions),
    ingester,
    updater,
    hostRules: new HostRuleService(db, updater),
    favicons: new FaviconService(db, fetcher, blobs, logger),
    fullText,
    iconTokens: new IconTokens(deps.keys['feed-icons']),
    images: new ImageProxy({ db, fetcher, blobs, key: deps.keys['image-url'], logger }),
    purger: new Purger(db, blobs, settings, { archive: deps.archive }),
    publishedPages: new PublishedPageService({
      db,
      fetcher,
      realtime: deps.realtime,
      logger,
      limits,
    }),
    rateLimits: limits,
  };
}

export type FeedServices = ReturnType<typeof createFeedServices>;
