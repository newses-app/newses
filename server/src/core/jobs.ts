import type { JobDefinitions } from './ports.ts';

export type Jobs = {
  /** Sources of one host, fetched one after another. */
  'feed.fetch': { feedSourceIds: number[] };
  'feed.favicon': { feedSourceId: number };
  /** Full text for a feed source's newest entries not tried yet. */
  'entry.extract': { feedSourceId: number };
  /** Runs plugins' due deliveries; queued on AWS when something becomes due. */
  'plugin.dispatch': Record<string, never>;
  /**
   * One user's digest: a due one, claimed until `lease` (sent only while that claim holds), or a
   * test digest.
   */
  'digest.send': { userId: number; lease: string } | { userId: number; test: true };
};

export const JOB_DEFINITIONS: JobDefinitions<Jobs> = {
  // Keyed by host. The updater schedules its own backoff, so failed fetches are not retried.
  'feed.fetch': { dedupeByKey: true, retryLimit: 0, timeoutSeconds: 900 },
  'feed.favicon': { dedupeByKey: true, retryLimit: 1, timeoutSeconds: 60 },
  // Keyed by feed source; failures are recorded per entry, so jobs are not retried.
  'entry.extract': { dedupeByKey: true, retryLimit: 0, timeoutSeconds: 600 },
  // Deliveries keep their own retries; a missed wake is caught up by the next one or the tick.
  'plugin.dispatch': { dedupeByKey: true, retryLimit: 0, timeoutSeconds: 300 },
  // Plugins may take 5 minutes to compose. A failed digest stays claimed until its lease lapses,
  // and a later dispatch claims it again, so jobs are not retried.
  'digest.send': { retryLimit: 0, timeoutSeconds: 600 },
};
