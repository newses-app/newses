import type { JobDefinitions } from './ports.ts';

export type Jobs = {
  'feed.fetch': { feedSourceId: number };
  'feed.favicon': { feedSourceId: number };
};

export const JOB_DEFINITIONS: JobDefinitions<Jobs> = {
  // The updater schedules its own backoff, so failed fetches are not retried by the queue.
  'feed.fetch': { dedupeByKey: true, retryLimit: 0, timeoutSeconds: 120 },
  'feed.favicon': { dedupeByKey: true, retryLimit: 1, timeoutSeconds: 60 },
};
