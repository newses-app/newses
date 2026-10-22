import type { BlobStore } from './ports.ts';

/** Copies in flight at once; S3 round trips dominate a copy's time. */
const CONCURRENCY = 16;

export interface BlobCopyTotals {
  count: number;
  bytes: number;
}

/**
 * Copies every blob under `prefix` from one store to another, keeping content types; blobs that
 * disappear while listed are skipped. `onProgress` is called after each copy.
 */
export async function copyBlobs(
  from: BlobStore,
  to: BlobStore,
  prefix = '',
  onProgress: (totals: BlobCopyTotals) => void = () => undefined,
): Promise<BlobCopyTotals> {
  const totals = { count: 0, bytes: 0 };
  const keys = from.list(prefix)[Symbol.asyncIterator]();
  const worker = async () => {
    for (let next = await keys.next(); !next.done; next = await keys.next()) {
      const blob = await from.get(next.value);
      if (!blob) continue;
      await to.put(next.value, blob);
      totals.count += 1;
      totals.bytes += blob.data.byteLength;
      onProgress(totals);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return totals;
}
