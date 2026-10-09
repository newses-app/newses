import type { Db } from '../../db/client.ts';
import { FilterService } from '../filters/filters.ts';
import type { Realtime } from '../ports.ts';
import { AccessKeyService } from './access-keys.ts';
import { CounterService } from './counters.ts';
import { EntryService } from './entries.ts';
import { LabelService } from './labels.ts';
import { SyncService } from './sync.ts';
import { TagService } from './tags.ts';

export function createEntryServices(db: Db, realtime: Realtime) {
  return {
    entries: new EntryService(db, realtime),
    counters: new CounterService(db),
    labels: new LabelService(db, realtime),
    tags: new TagService(db),
    accessKeys: new AccessKeyService(db),
    sync: new SyncService(db),
    filters: new FilterService(db, realtime),
  };
}

export type EntryServices = ReturnType<typeof createEntryServices>;
