import { randomUUID } from 'node:crypto';
import { parquetWriteBuffer, type SchemaElement } from 'hyparquet-writer';
import type { ArchiveRow, ArchiveWriter, BlobStore } from '../core/ports.ts';
import {
  ARCHIVE_COLUMNS,
  ARCHIVE_CONTENT_TYPE,
  ARCHIVE_PARTITION,
  ARCHIVE_PREFIX,
  type ArchiveField,
  type ArchiveFieldType,
  archiveMonth,
  ENCLOSURE_FIELDS,
  ENCLOSURES_COLUMN,
} from './archive-format.ts';

const PHYSICAL: Record<ArchiveFieldType, Omit<SchemaElement, 'name' | 'repetition_type'>> = {
  int: { type: 'INT32' },
  bigint: { type: 'INT64' },
  string: { type: 'BYTE_ARRAY', converted_type: 'UTF8' },
  timestamp: {
    type: 'INT64',
    logical_type: { type: 'TIMESTAMP', isAdjustedToUTC: true, unit: 'MILLIS' },
  },
};

const element = ({ name, type, required }: Omit<ArchiveField<never>, 'field'>): SchemaElement => ({
  name,
  repetition_type: required ? 'REQUIRED' : 'OPTIONAL',
  ...PHYSICAL[type],
});

/** Columns, then `enclosures` as a three-level LIST of structs. */
const SCHEMA: SchemaElement[] = [
  { name: 'root', num_children: ARCHIVE_COLUMNS.length + 1 },
  ...ARCHIVE_COLUMNS.map(element),
  {
    name: ENCLOSURES_COLUMN,
    repetition_type: 'REQUIRED',
    converted_type: 'LIST',
    num_children: 1,
  },
  { name: 'list', repetition_type: 'REPEATED', num_children: 1 },
  { name: 'element', repetition_type: 'REQUIRED', num_children: ENCLOSURE_FIELDS.length },
  ...ENCLOSURE_FIELDS.map(element),
];

/** INT64 columns take bigints. */
const value = (type: ArchiveFieldType, v: unknown) =>
  type === 'bigint' && typeof v === 'number' ? BigInt(v) : v;

/** A Parquet file of rows, sorted by feed and time so readers can skip other feeds' row groups. */
export function archiveFile(rows: ArchiveRow[]): Uint8Array {
  const sorted = rows.toSorted(
    (a, b) =>
      (a.feedUrl < b.feedUrl ? -1 : a.feedUrl > b.feedUrl ? 1 : 0) ||
      a.sortAt.getTime() - b.sortAt.getTime(),
  );
  const buffer = parquetWriteBuffer({
    schema: SCHEMA,
    columnData: [
      ...ARCHIVE_COLUMNS.map(({ name, field, type }) => ({
        name,
        data: sorted.map((row) => value(type, row[field])),
      })),
      {
        name: ENCLOSURES_COLUMN,
        data: sorted.map((row) =>
          row.enclosures.map((enclosure) =>
            Object.fromEntries(
              ENCLOSURE_FIELDS.map(({ name, field, type }) => [
                name,
                value(type, enclosure[field]),
              ]),
            ),
          ),
        ),
      },
    ],
  });
  return new Uint8Array(buffer);
}

/** Writes archive rows as one new Parquet file per month under the blob root. */
export class ParquetArchiveWriter implements ArchiveWriter {
  readonly #blobs: BlobStore;

  constructor(blobs: BlobStore) {
    this.#blobs = blobs;
  }

  async write(rows: ArchiveRow[]): Promise<void> {
    const months = Map.groupBy(rows, archiveMonth);
    for (const [month, monthRows] of months) {
      await this.#blobs.put(
        `${ARCHIVE_PREFIX}/${ARCHIVE_PARTITION}=${month}/${randomUUID()}.parquet`,
        { data: archiveFile(monthRows), contentType: ARCHIVE_CONTENT_TYPE },
      );
    }
  }
}
