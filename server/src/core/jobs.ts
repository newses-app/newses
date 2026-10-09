import type { JobDefinitions } from './ports.ts';

export type Jobs = {
  /** Sources of one host, fetched one after another. */
  'feed.fetch': { feedSourceIds: number[] };
  'feed.favicon': { feedSourceId: number };
  /** Full text for a feed source's newest entries not tried yet. */
  'entry.extract': { feedSourceId: number };
};

export const JOB_DEFINITIONS: JobDefinitions<Jobs> = {
  // Keyed by host. The updater schedules its own backoff, so failed fetches are not retried.
  'feed.fetch': { dedupeByKey: true, retryLimit: 0, timeoutSeconds: 900 },
  'feed.favicon': { dedupeByKey: true, retryLimit: 1, timeoutSeconds: 60 },
  // Keyed by feed source; failures are recorded per entry, so jobs are not retried.
  'entry.extract': { dedupeByKey: true, retryLimit: 0, timeoutSeconds: 600 },
};
