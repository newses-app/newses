import type { ArchivedEnclosure, ArchiveRow } from '../core/ports.ts';

// The cold-storage archive's file layout, shared by its writer, its readers, and the AWS catalog.

/** Archive files live under this blob prefix, in one folder per month of `sort_at`. */
export const ARCHIVE_PREFIX = 'archive/entries';

/** The Hive-style partition key of the month folders, `month=YYYY-MM`. */
export const ARCHIVE_PARTITION = 'month';

/** Timestamps are UTC milliseconds. */
export type ArchiveFieldType = 'int' | 'bigint' | 'string' | 'timestamp';

export interface ArchiveField<R> {
  name: string;
  field: keyof R & string;
  type: ArchiveFieldType;
  required: boolean;
}

/** Fields of each element of the `enclosures` list. */
export const ENCLOSURE_FIELDS: readonly ArchiveField<ArchivedEnclosure>[] = [
  { name: 'url', field: 'url', type: 'string', required: true },
  { name: 'mime_type', field: 'mimeType', type: 'string', required: false },
  { name: 'length', field: 'length', type: 'bigint', required: false },
  { name: 'width', field: 'width', type: 'int', required: false },
  { name: 'height', field: 'height', type: 'int', required: false },
  { name: 'duration_seconds', field: 'durationSeconds', type: 'int', required: false },
];

/** Columns of archive files in order, apart from `enclosures`, which comes last. */
export const ARCHIVE_COLUMNS: readonly ArchiveField<ArchiveRow>[] = [
  { name: 'id', field: 'id', type: 'bigint', required: false },
  { name: 'feed_url', field: 'feedUrl', type: 'string', required: true },
  { name: 'feed_title', field: 'feedTitle', type: 'string', required: false },
  { name: 'guid', field: 'guid', type: 'string', required: true },
  { name: 'link', field: 'link', type: 'string', required: false },
  { name: 'title', field: 'title', type: 'string', required: false },
  { name: 'author', field: 'author', type: 'string', required: false },
  { name: 'content', field: 'content', type: 'string', required: false },
  { name: 'text', field: 'text', type: 'string', required: false },
  { name: 'lang', field: 'lang', type: 'string', required: false },
  { name: 'published_at', field: 'publishedAt', type: 'timestamp', required: false },
  { name: 'source_updated_at', field: 'sourceUpdatedAt', type: 'timestamp', required: false },
  { name: 'fetched_at', field: 'fetchedAt', type: 'timestamp', required: true },
  { name: 'sort_at', field: 'sortAt', type: 'timestamp', required: true },
  { name: 'archived_at', field: 'archivedAt', type: 'timestamp', required: true },
];

export const ENCLOSURES_COLUMN = 'enclosures';

/** The month folder of a row: `YYYY-MM` of its `sort_at`, in UTC. */
export const archiveMonth = (row: Pick<ArchiveRow, 'sortAt'>) =>
  row.sortAt.toISOString().slice(0, 7);
