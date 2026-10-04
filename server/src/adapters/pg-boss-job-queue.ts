import type { PgBoss, SendOptions } from 'pg-boss';
import type { EnqueueOptions, JobDefinitions, JobMap, JobQueue } from '../core/ports.ts';

/** JobQueue on pg-boss. The caller owns the PgBoss instance and must start it before use. */
export class PgBossJobQueue<J extends JobMap> implements JobQueue<J> {
  readonly #boss: PgBoss;
  readonly #definitions: JobDefinitions<J>;
  readonly #queues = new Map<string, Promise<void>>();

  constructor(boss: PgBoss, definitions: JobDefinitions<J>) {
    this.#boss = boss;
    this.#definitions = definitions;
  }

  async enqueue<N extends keyof J & string>(
    name: N,
    data: J[N],
    options: EnqueueOptions = {},
  ): Promise<boolean> {
    if (this.#definitions[name].dedupeByKey && options.key === undefined) {
      throw new Error(`Job "${name}" deduplicates by key, so enqueue needs a key`);
    }
    await this.#ensureQueue(name);
    const sendOptions: SendOptions = {};
    if (options.key !== undefined) sendOptions.singletonKey = options.key;
    if (options.delaySeconds !== undefined) sendOptions.startAfter = options.delaySeconds;
    return (await this.#boss.send(name, data, sendOptions)) !== null;
  }

  async work<N extends keyof J & string>(
    name: N,
    handler: (data: J[N]) => Promise<void>,
    options: { concurrency?: number } = {},
  ): Promise<void> {
    await this.#ensureQueue(name);
    await this.#boss.work<J[N]>(
      name,
      { localConcurrency: options.concurrency ?? 1 },
      async (jobs) => {
        for (const job of jobs) await handler(job.data);
      },
    );
  }

  #ensureQueue(name: keyof J & string): Promise<void> {
    let ready = this.#queues.get(name);
    if (!ready) {
      const definition = this.#definitions[name];
      ready = this.#boss.createQueue(name, {
        // `short` allows one queued job per singletonKey, plus any number active.
        policy: definition.dedupeByKey ? 'short' : 'standard',
        retryLimit: definition.retryLimit ?? 3,
        retryDelay: definition.retryDelaySeconds ?? 30,
        retryBackoff: true,
        expireInSeconds: definition.timeoutSeconds ?? 300,
      });
      this.#queues.set(name, ready);
    }
    return ready;
  }
}
