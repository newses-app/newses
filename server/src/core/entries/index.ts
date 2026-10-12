import type { Db } from '../../db/client.ts';
import { FilterService } from '../filters/filters.ts';
import type { ArchiveReader, Realtime } from '../ports.ts';
import { ArchiveService } from './archive.ts';
import { AccessKeyService } from './access-keys.ts';
import { CounterService } from './counters.ts';
import { EntryService } from './entries.ts';
import { LabelService } from './labels.ts';
import { SyncService } from './sync.ts';
import { TagService } from './tags.ts';

/** `archive` reads the cold-storage archive; null lists only what the database still holds. */
export function createEntryServices(
  db: Db,
  realtime: Realtime,
  archive: ArchiveReader | null = null,
) {
  const entries = new EntryService(db, realtime);
  return {
    entries,
    archive: new ArchiveService(db, entries, archive),
    counters: new CounterService(db),
    labels: new LabelService(db, realtime),
    tags: new TagService(db),
    accessKeys: new AccessKeyService(db),
    sync: new SyncService(db),
    filters: new FilterService(db, realtime),
  };
}

export type EntryServices = ReturnType<typeof createEntryServices>;
