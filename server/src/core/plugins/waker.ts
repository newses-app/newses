import type { Jobs } from '../jobs.ts';
import type { JobQueue, Logger, Realtime } from '../ports.ts';
import type { PluginEventService } from './events.ts';

/**
 * Where nothing polls for plugin deliveries (AWS), queues a `plugin.dispatch` for when the next
 * one is due, after changes that may have recorded events. Within a process, a wake already
 * queued for that time or earlier is not queued again.
 */
export class PluginWaker {
  readonly #events: Pick<PluginEventService, 'listening' | 'nextDueSeconds'>;
  readonly #queue: Pick<JobQueue<Jobs>, 'enqueue'>;
  readonly #logger: Logger;
  /** When the earliest wake this process queued fires, epoch ms. */
  #queuedFor = 0;

  constructor(deps: {
    events: Pick<PluginEventService, 'listening' | 'nextDueSeconds'>;
    queue: Pick<JobQueue<Jobs>, 'enqueue'>;
    logger: Logger;
  }) {
    this.#events = deps.events;
    this.#queue = deps.queue;
    this.#logger = deps.logger;
  }

  /** Queues a wake for the next due delivery, if one waits; never throws. */
  async wake(): Promise<void> {
    if (!this.#events.listening) return;
    try {
      const seconds = await this.#events.nextDueSeconds();
      if (seconds === null) return;
      const at = Date.now() + seconds * 1000;
      if (this.#queuedFor > Date.now() && this.#queuedFor <= at) return;
      await this.#queue.enqueue(
        'plugin.dispatch',
        {},
        { key: 'plugin.dispatch', delaySeconds: seconds },
      );
      this.#queuedFor = at;
    } catch (err) {
      this.#logger.warn({ err }, 'Plugin deliveries not woken');
    }
  }
}

/** Realtime that wakes the plugin deliveries after each change to a user's counts. */
export function wakingRealtime(realtime: Realtime, waker: Pick<PluginWaker, 'wake'>): Realtime {
  return {
    async publish(userId, event) {
      await realtime.publish(userId, event);
      await waker.wake();
    },
    subscribe: (userId, listener) => realtime.subscribe(userId, listener),
    ...(realtime.changesPath && {
      changesPath: (userId: number) => realtime.changesPath?.(userId) ?? '',
    }),
  };
}
