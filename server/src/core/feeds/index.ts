import type { Db } from '../../db/client.ts';
import { CategoryService } from '../categories.ts';
import type { Fetcher } from './http.ts';
import { OpmlService } from './opml.ts';
import { SubscriptionService } from './subscriptions.ts';

export function createFeedServices(db: Db, fetcher: Fetcher) {
  const categories = new CategoryService(db);
  const subscriptions = new SubscriptionService(db, fetcher);
  const opml = new OpmlService(db, categories, subscriptions);
  return { categories, subscriptions, opml };
}

export type FeedServices = ReturnType<typeof createFeedServices>;
