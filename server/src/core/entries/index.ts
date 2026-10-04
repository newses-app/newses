import type { Db } from '../../db/client.ts';
import type { Realtime } from '../ports.ts';
import { CounterService } from './counters.ts';
import { EntryService } from './entries.ts';
import { SyncService } from './sync.ts';

export function createEntryServices(db: Db, realtime: Realtime) {
  return {
    entries: new EntryService(db, realtime),
    counters: new CounterService(db),
    sync: new SyncService(db),
  };
}

export type EntryServices = ReturnType<typeof createEntryServices>;
